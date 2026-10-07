# @polarispay/underwriting

**The credit decision behind Pay in 4.** Nansen's view of a wallet's history
becomes the facts a Chainlink DON attests, `ScoreManager` turns those facts
into a score on chain, and this package turns the same facts into the product
decision the buyer sees: the line, whether Pay in 4 fits this purchase, what
would raise it, and why, in the buyer's words.

```
You can pay in 4 for up to $992.38.
  nansen     You've used your linked account for 3 years · +60
  zerion     You keep $4,237 on hand across your accounts · +42
  rpc        You've made 902 payments and transfers · +36
  zerion     You've used savings and trading apps for over 2 years · +24
  nansen     First topped up from Coinbase, a major exchange · +10
  etherscan  No past loans closed by a lender · +0
```

## Setup (one command)

```bash
pnpm install && pnpm --filter @polarispay/underwriting test
```

The tests answer the providers from the fixtures in
[`fixtures/`](fixtures/README.md), no keys needed. The fixtures are test
doubles: they live behind `@polarispay/underwriting/testing`, which no product
path imports (`test/no-fixtures-in-product.test.ts` checks the package, the
gateway, the API, the app and the CRE workflow and its local runner).

To serve the API, `pnpm --filter @polarispay/gateway start` (port 3510), with
the keys you have in `apps/gateway/.env`. **There are two modes per provider,
and no third:** a provider with its key is `live`; one without is
`not_configured`. A provider that is not configured is never called and
nothing answers in its place: the evidence only it reads is absent (see
"Missing keys" below), and `/health` and every assessment name it. Public RPCs
need no key and are always live.

| Variable | Enables |
|---|---|
| `NANSEN_API_KEY` | Live Nansen: first funder, related wallets, the balance and trading fallbacks. Without it a linked wallet's risk checks cannot run |
| `ZERION_API_KEY` | Live Zerion: exact balances, tenure probes, the account's Monad testnet history |
| `ETHERSCAN_API_KEY` | Live Etherscan V2: past liquidations, testnet token transfers (the account's history when Zerion is not configured) |
| `NANSEN_LABELS=1` | Spend 100 credits per linked wallet on Nansen's labels for the risk screen |
| `UNDERWRITING_ALLOW_PARTIAL=1` | Underwrite conservatively instead of asking the app to retry |

`UNDERWRITING_MODE=fixture` no longer exists: `Underwriter.fromEnv` refuses
to start with it, so a deployment that still sets it finds out at once.

## Why Nansen is load-bearing

The Nansen bounty asks for a product experience that goes beyond exposing raw
data. Here, Nansen's data decides how much credit a person gets:

- **First funder** dates a linked wallet (its age earns up to 60 points),
  names the exchange it was first topped up from (+10), and names the funder
  the sybil check runs on.
- **Related wallets** on that funder is the sybil check: 4 to 24 accounts from
  one non-exchange funder cost up to 80 points, and 25 or more decline the
  line outright.
- **The funder's label** is a risk screen: a wallet first funded through a
  mixer or by an exploiter is not counted as history at all.
- **Current balance** and **transactions** are the fallbacks when Zerion is
  down or cannot track an address.

Take Nansen away (no `NANSEN_API_KEY`) and a linked wallet cannot be
underwritten: its risk checks cannot run, so it is left out, nothing is
reported, and the outcome says Nansen is not configured rather than asking
the buyer to retry. Every
reason line carries `provider: "nansen"` where Nansen backs it, so the app can
credit it.

## Layout

| Path | What it is |
|---|---|
| `src/core/` | The pure half: types, the data recipe, Facts derivation, the score mirror, the decision, reasons, ABI encoding, and each provider's request builders and response parsers. No Node API, no clock, no randomness, no dependency. This is what the CRE workflow bundles |
| `src/node/` | Provider clients (live or not configured; retries, timeouts, rate limits, cache), the Node driver for the recipe, the service, and the HTTP handler |
| `src/client/` | The typed client the app's server uses to call the gateway (`@polarispay/underwriting/client`) |
| `src/testing/` | Test doubles, for tests only (`@polarispay/underwriting/testing`): the transport that answers from `fixtures/` |
| `fixtures/` | Synthesized provider responses in the documented shapes, clearly labelled, for the tests ([README](fixtures/README.md)) |
| `scripts/` | `synthesize-fixtures.ts` writes the fixtures; `record.ts` records real ones once keys exist |
| `test/` | 285 tests: the mirror, the encoding, derivation, reasons, parsers, HTTP, clients, personas, failures, missing keys, the recipe in both runtimes, the service, the API, and no fixtures in the product. `packages/contracts/test/metropolis/UnderwritingPackage.test.js` holds the package to the deployed contracts |

`tsconfig.core.json` typechecks `src/core` with no `node` or `dom` types, and
`test/core-purity.test.ts` rejects `Date.now`, `Math.random`, `Intl`, timers
and imports from outside the core, so the core stays safe to compile to WASM.

## The Facts encoding

`Facts` is `ScoreManager.Facts`, field for field and in the same order. uint64
fields are `bigint` in TypeScript; the others are `number`.

| Word | Field | Solidity | Meaning |
|---|---|---|---|
| 0 | `walletAgeDays` | `uint32` | Days since the oldest activity across the buyer's accounts |
| 1 | `txCount` | `uint32` | Payments and transfers sent |
| 2 | `stableBalance` | `uint64` | Dollars held, 6-decimal base units |
| 3 | `defiTenureDays` | `uint32` | Days since the first savings, lending or trading action |
| 4 | `priorLiquidations` | `uint16` | Loans closed by an allowlisted Aave V3 pool |
| 5 | `relatedWallets` | `uint16` | Accounts from the same funder, when that is a cluster (see below) |
| 6 | `exchangeFunded` | `bool` | First topped up from a known exchange |
| 7 | `observedAt` | `uint64` | Unix seconds the facts were read: DON time, never the node's clock |

`encodeFacts(f)` is `abi.encode(f)`: eight 32-byte words, each left-padded
big-endian, 256 bytes. **The report the DON signs** is the one the deployed
`UnderwritingReceiver` decodes (`packages/contracts/contracts/cre/UnderwritingReceiver.sol`
on `metropolis/cre`):

```
encodeUnderwritingReport(items) = abi.encode(uint8 kind, Underwriting[] items)     kind = 2
Underwriting = (address user, address linkedWallet, Facts facts)
```

`linkedWallet` is the history wallet the buyer proved they own, or zero for an
account scored alone; the receiver records it so one wallet backs one account,
ever. The array is dynamic: two head words (kind, offset `0x40`), the length,
then each item's ten words inline, so one underwriting is 96 + 320 = 416
bytes. `decodeUnderwritingReport(hex)` accepts what the receiver's
`abi.decode` accepts and refuses the rest, including any kind but 2.
`FACTS_ABI_TUPLE`, `UNDERWRITING_ITEM_ABI_TUPLE` and `UNDERWRITING_REPORT_ABI`
are the same types as strings for viem's `parseAbiParameters`. Values that do
not fit their width throw instead of truncating; the tests check the bytes
against viem with the receiver's types written out by hand, and against the
deployed `ScoreManager`.

The package used to export `encodeUnderwriteReport(user, f)`, the single-item
`(uint8, address, Facts)` of the research sketch (docs/research/cre.md §7.7).
No deployed receiver decodes it and it carried no linked wallet, so it was
removed rather than deprecated: a report in that shape reverts on chain.

## Deriving the facts (v1)

`FACTS_VERSION = 1`. `deriveFacts` refuses any other version, so an old report
stays reproducible after the rules change.

| Fact | Rule |
|---|---|
| `walletAgeDays` | max over the account and the linked wallet of `floor((observedAt − firstSeenAt) / 86400)` |
| `txCount` | sum of sent counts, saturating at uint32 |
| `stableBalance` | sum of dollars held, saturating at uint64 |
| `defiTenureDays` | max over subjects of days since the first trade, deposit or withdrawal |
| `priorLiquidations` | sum, saturating at uint16 |
| `exchangeFunded` | the linked wallet's Nansen first funder names a known exchange (`EXCHANGES`) |
| `relatedWallets` | the linked wallet's cluster, but 0 when it was exchange-funded or its funder ties to 60 or more wallets (`INFRASTRUCTURE_OUTDEGREE`): that is a faucet or an exchange, not one person |

The recipe that gathers the evidence lives in the core
([`src/core/recipe.ts`](src/core/recipe.ts)): generators that yield batches of
requests and read the replies, fallbacks included. Node drives them with
`runAsync` (each batch concurrently, through the clients); the CRE workflow
drives the same generators with `runSync`. A test runs every persona both
ways and requires identical evidence within CRE's 15 HTTP calls. Where each
piece of evidence comes from, first source that answers wins:

| Evidence | Polaris account (Monad testnet) | Linked wallet (mainnet history) |
|---|---|---|
| first seen | Zerion testnet transactions → Etherscan `tokentx` | **Nansen first-funder** → Zerion probes |
| sent count | Zerion testnet transactions → Etherscan `tokentx` | RPC nonces on Ethereum, Base, Monad → Zerion (capped at 100) |
| dollars held | RPC `balanceOf` AUSD + USDC | Zerion positions (exact) → **Nansen current-balance** |
| trading since | none by rule | Zerion probes → **Nansen transactions** (`dex`, last year) |
| liquidations | none by rule | Etherscan V2 logs, allowlisted pools only |
| funder, cluster, risk label | none by rule (gasless) | **Nansen first-funder, related-wallets**, labels when enabled |

A linked wallet is **admitted** only if its ownership was proven by signature
(`linkMessage`, checked with viem's `verifyMessage`), it carries no high-risk
label, and every risk check on it ran. **Missing data is never attested as
zero**: the outcome is `final: false` with the missing fields listed, the
report is `null`, and the app shows a preview that never counts an unchecked
wallet. Nansen spends 2 credits per linked wallet (1 when exchange-funded).

### Missing keys: absent, never invented

A provider without its key is not configured. The driver answers its
requests with `notConfiguredReply` (code `not_configured`, naming the
variable) without sending them, the recipe asks the next source in the row,
and a field no configured source could read gets status `not_configured`
(`missing` is kept for a source that failed and may answer later). Then:

- **A positive field** (first seen, sent count, dollars, trading since) is
  absent: it earns no points and does not hold the report back, since asking
  again cannot change it. It is listed in `absent`.
- **A risk field** (liquidations, cluster, risk label, first funder) is absent
  and missing: the linked wallet is left out and nothing is final. One
  underwriting per account, which binds the linked wallet to it, should not
  be spent without the history, so it waits for the key.
- **`unavailable: true`** when nothing can be attested for want of keys: an
  absent risk check, or a thin file whose age or activity was absent (that
  may not be thin at all). The headline says "Credit reviews aren't fully set
  up here yet.", no next step promises when Pay in 4 opens, and
  `retryAfterSeconds` is null.
- The Node assessment carries `providers` (each `live` or `not_configured`)
  and `notConfigured` (`[{ provider: "nansen", env: "NANSEN_API_KEY" }]`), so
  a screen can say "Nansen not configured". The report format is unchanged.

Without Nansen, the account alone is still underwritten from Zerion or
Etherscan and the public RPC; without Zerion, Etherscan's token transfers
date the account; without both, its history is absent and it is
`unavailable`.

## The score, the line and the decision

The score is `ScoreManager.scoreFromFacts`, mirrored exactly in BigInt
(`scoreFromFacts`, `scoreBreakdown`):

| Term | Points |
|---|---|
| Floor | 520 |
| Age | `floor(days / 30) × 2`, up to 60 |
| Activity | `floor(txCount / 25)`, up to 50 |
| Dollars | 1 per $100, up to 50 |
| Trading tenure | 1 per 30 days, up to 30 |
| First funded from an exchange | +10 |
| Each prior liquidation | −75 |
| Cluster above 3 | −2 each, up to −80 |

Clamped to 300–739; declined at 2 liquidations or 25 related wallets. The line
is `ScoreManager.baseLimitOf`'s tier: $200 below 580, $500, $1,000 from 670.
An underwritten line never opens above $1,000; $2,500 and $5,000 come only
from repaying (+12 per on-time week).

`decide()` turns that into the product decision (`CreditDecision`):

- `limit`, `available` (after open plans), `tier`, `nextTier` with the on-time
  weeks to reach it.
- `payIn4.allowed`, `payIn4.maxPurchase` and `payIn4.quote`, computed with
  `PolarisLoanEngine`'s integer interest and threshold ladder, so a plan fits
  here exactly when `createLoan` accepts it (the Hardhat suite checks this to
  the base unit).
- Cold start (plan §5.5): at the $200 floor a $200 purchase plus interest does
  not fit; the decision says by how much and how much collateral would cover
  it.
- `thinFile`: the thin-file gate, below.
- `nextSteps`: link a wallet, keep using Polaris (`build-history`), repay on
  time, set money aside, or retry.

### The thin-file gate: an empty account is never attested

ScoreManager opens every underwritten wallet at the 520 floor, a $200
unsecured line, whatever the facts say. So a report for an account with no
history is a free $200: one person could open many free accounts, underwrite
each and draw about $196 from every one (security review, "sybil credit
farming", proven on a Hardhat chain). The sybil and one-link checks only see a
linked wallet, so they do not help an account that brings none.

`underwrite()` therefore attests only facts that show a life elsewhere,
exactly as `ScoreManager.isThinFile` requires on chain (the contract refuses
anything less with `ThinFile`): **at least 90 days of history and at least
10 payments and transfers**, counted across the account and a linked wallet
that passed its checks (`isAttestable`, `attestGaps` and `ATTEST_MINIMUM` in
`core/attest.ts`; `ATTEST_MINIMUM` is the contract's `MIN_HISTORY_DAYS` and
`MIN_HISTORY_TXS`). Dollars do not count: one balance can be walked through
account after account inside the 15 minutes a report is good for. A declined
file is attested even when thin, so the decline sticks and the wallet can
never back another account.

Below the gate the outcome is `final: true, attest: false, report: null`,
and the decision is secured-only, exactly as ScoreManager treats a wallet
never underwritten while `requireUnderwriting` is on: `limit` 0, collateral
at face value, `thinFile` listing what is still missing (`{ fact, have,
need }`; all of it is needed), and the next steps "Open a line now: confirm
with the wallet you already use" and "Keep using Polaris: Pay in 4 opens in
87 days, once you've made 8 more payments and transfers". No report also keeps the one
underwriting an account gets for when it has the history.
`explainOnChainFacts` does not apply the gate: facts already attested are
explained as the chain scored them.

The CRE underwriting workflow applies the same gate
(`workflows/src/underwriting/thin.ts`), and `ScoreManager.underwrite`
refuses thin facts itself; a seeded sweep in `test/facts.test.ts` holds the
package to the contract's rule, so the app's preview never promises a line
the DON will not attest or the chain would refuse. The API rate-limits
underwriting per verified account and activates merchants for Pay in 4 only
after real sales.

## API

### Core (`@polarispay/underwriting/core`, dependency-free)

```ts
underwrite(input: {
  user: Address; observedAt: number | bigint;
  account: SubjectEvidence; linked?: SubjectEvidence | null; linkVerified?: boolean;
  activeDebt?: bigint; purchase?: bigint | null; options?: { allowPartial?: boolean; version?: number };
}): { version; user; final; attest; missing: string[]; absent: string[]; unavailable: boolean; facts: Facts; linkedWallet: Address | null;
      report: Hex | null;   // UnderwritingReceiver's batch with this one underwriting; set exactly when attest
      breakdown: ScoreBreakdown; decision: CreditDecision; derivation: Derivation }

deriveFacts({ account, linked?, observedAt, options? }): Derivation
scoreFromFacts(f): { score, declined }            scoreBreakdown(f): ScoreBreakdown
decide({ score, declined, declineReason?, activeDebt?, purchase?, collateralBoost?, reasons?, hasLinked?, pending?, thinFile? }): CreditDecision
isAttestable(facts): boolean    attestGaps(facts): AttestGap[]    ATTEST_MINIMUM = { walletAgeDays: 30, txCount: 25, defiTenureDays: 30 }  // any one, or exchange funding
explainFacts(facts, breakdown, context?): CreditReason[]    poweredBy(reasons): ProviderCredit[]    PROVIDER_NAMES
explainOnChainFacts(facts, { activeDebt?, purchase?, hasLinked? }): { breakdown, decision }
quotePlan(principal, installments = 4, intervalSeconds = 604800, aprBps = 1000): PlanQuote
maxPrincipal(available, ...): bigint             tierFor(score) · limitFor(score, declined) · nextTierFor(score)
encodeFacts(f): Hex        encodeUnderwritingReport([{ user, linkedWallet: Address | null, facts }]): Hex
decodeFacts(hex): Facts    decodeUnderwritingReport(hex): { kind: 2, items: UnderwritingItem[] }    validateFacts(f)
linkMessage({ account, wallet, issuedAt, nonce }): string    linkProofStaleness(issuedAt, now)
evidence.{ok,fallback,empty,missing,notConfigured}(value, source, detail?)   accountRules()   toJsonSafe(value)
notConfiguredReply(spec): Reply   notConfiguredProviders(issues): KeyedProvider[]   PROVIDER_KEYS   // { nansen: "NANSEN_API_KEY", ... }
nansen.{nansenRequests, parseFirstFunder, parseRelatedWallets, parseCurrentBalanceStables, parseOldestTransaction, parseLabels, parseCounterparties, parsePnlSummary, parseNansenError}
zerion.{zerionRequests, zerionAuthorization, parseTransactions, countedRows, parsePositionsStables, isNotTrackable}
etherscan.{etherscanRequests, parseLiquidationCount, parseTokenTransfers}
rpc.{rpcRequests, parseRpcQuantity, parseRpcResult}
accountRecipe(address, { now, accountBalance?, ... }) · linkedRecipe(address, { now, useNansenLabels?, ... }): Recipe<{ evidence, issues }>
runSync(recipe, send: (spec) => Reply): T        runAsync(recipe, send: (spec) => Promise<Reply>): Promise<T>
  Reply = { ok: true, status, body } | { ok: false, code, retryable, retryAfterMs, message }
all([recipeA, recipeB, ...])                    // run recipes in lockstep, one batch per round
largestHit(edges, hit)                          // the probe binary search
```

The request builders return `{ method, url, headers, body }` without secrets
and byte-identically on every node (lowercase addresses, fixed key order,
dates rounded to the minute), which CRE's `cacheSettings` needs to share one
paid call across the DON.

### Node (`@polarispay/underwriting`)

Everything in the core, plus:

```ts
new NansenClient(opts)    firstFunder · relatedWallets · currentBalanceStables · oldestTransaction · counterparties · pnlSummary · labels
new ZerionClient(opts)    transactions · hasActivityBefore · positionsStables
new EtherscanClient(opts) liquidationCount · tokenTransfers
new RpcClient(url, chainId, opts)  transactionCount · balanceOf · isContract
  opts: { apiKey?, transport?, retry?, clock?, minIntervalMs?, cacheTtlMs?, onResponse? }   // .mode: "live" | "not_configured" (no key: every call fails not_configured, nothing sent)
collectAccount(address, providers, { now }) · collectLinked(address, providers, { now, useNansenLabels? })   // runAsync over the recipes
sender(providers): (spec) => Promise<Reply>     // each request through its provider's client
Underwriter.fromEnv(env?) · new Underwriter({ providers, now?, allowPartial? })
  .assess({ account, linked?: { wallet, proof? }, purchase?, activeDebt?, allowPartial? }): Promise<Assessment>
  .modes()            // { nansen, zerion, etherscan, rpc }: "live" | "not_configured"
  .notConfigured()    // [{ provider, env }] for each keyed provider without its key
createRouter(underwriter, opts) · createNodeHandler(underwriter, opts) · createFetchHandler(underwriter, opts)
startUnderwritingServer({ port?, host?, token?, corsOrigins?, underwriter? })   // refuses a non-loopback host without a token
isLoopbackHost(host): Promise<boolean> · isLoopbackAddress(ip) · assertSafeBind(host, token)
```

Clients retry network errors, timeouts, 408/425/429 and 5xx with jittered
backoff, honour `Retry-After` and Nansen's `retry_after` (but never make a
buyer wait more than 12 s), time out each attempt at 10 s like CRE, space
requests to each plan's rate, and cache successes for 10 minutes keyed without
the secret, so a retry does not spend a second Nansen credit.

### HTTP (served by `apps/gateway` on port 3510)

| Route | Body | Returns |
|---|---|---|
| `GET /health` | | `{ ok, version: { facts, model }, modes, notConfigured }`: each provider `live` or `not_configured`, and `[{ provider, env }]` for those without a key |
| `POST /v1/underwrite` | `{ account, linked?: { wallet, proof?: { issuedAt, nonce, signature } }, purchase?: "200.00", activeDebt?: "<base units>", allowPartial? }` | The assessment: `final`, `missing`, `absent`, `unavailable`, `facts`, `report`, `breakdown`, `decision`, `evidence`, `attribution`, `issues`, `retryAfterSeconds`, `providers`, `notConfigured`, `credits` |
| `POST /v1/explain` | `{ facts }` or `{ report }` (the body `UnderwritingReceiver.onReport` received), optional `purchase`, `activeDebt` | For facts: `{ user: null, linkedWallet: null, facts, breakdown, decision }`. For a report: `{ kind, items: [{ user, linkedWallet, facts, breakdown, decision }] }`, with the one item's fields also at the top level when there is exactly one |
| `GET /v1/link-message` | `?account&wallet&issuedAt&nonce` | `{ message }`: the exact text the linked wallet signs |

Bigints travel as decimal strings in base units. `/v1/*` requires
`Authorization: Bearer $UNDERWRITING_API_TOKEN` when it is set; without one,
`startUnderwritingServer` binds loopback only and refuses any other host
(`isLoopbackHost`, `assertSafeBind`). A Fetch handler mounted in a deployed
app cannot tell, so give it the token. CORS is an
allowlist (`UNDERWRITING_CORS_ORIGINS`, never `*`), bodies are capped at
16 KB, and underwriting is rate-limited per client because it spends credits.
A Next.js route can mount the same API: `export const POST = (r: Request) => createFetchHandler(Underwriter.fromEnv())(r)`.
`/v1/explain` takes the purchase as dollars (`purchase: "200.00"`) or base
units (`purchaseBaseUnits`), like `/v1/underwrite`.

### Client (`@polarispay/underwriting/client`, for the app's server)

How a buyer gets to see a Nansen-powered decision: the app's server calls
the gateway with the bearer token and renders what comes back. Nothing but
`fetch`, so it runs in a Next.js route handler.

```ts
import { createUnderwritingClient, poweredBy } from "@polarispay/underwriting/client";

const uw = createUnderwritingClient({ baseUrl: process.env.UNDERWRITING_API_URL!, token: process.env.UNDERWRITING_API_TOKEN });
// Bring your history: the buyer's existing wallet signs this text (WalletConnect), then:
const message = await uw.linkMessage({ account, wallet, issuedAt, nonce });
const a = await uw.underwrite({ account, linked: { wallet, proof: { issuedAt, nonce, signature } }, purchase: 200_000_000n });
a.decision.headline;          // "You can pay in 4 for up to $600.00."
a.decision.reasons;           // [{ text: "First topped up from Coinbase, a major exchange · +10", provider: "nansen", ... }]
poweredBy(a.decision.reasons) // [{ provider: "nansen", name: "Nansen", reasons: ["age", "exchange", "cluster"] }, ...]
a.attest ? a.report : a.decision.thinFile; // what the CRE workflow will attest, or what is left before it can
// After the DON's report lands: explain exactly what it attested.
const { items } = await uw.explainReport(reportBody);
```

Amounts travel as base-unit decimal strings (`Wire<T>`), errors as
`UnderwritingApiError` with the API's code (`unauthorized`, `rate_limited`,
`invalid_field`). The token is a server secret: never call the gateway from a
browser.

### In the CRE workflow

The workflow that runs this is `workflows/src/underwriting/` (package
`@polaris/cre-workflows`; see its [README](../../workflows/README.md)). In
node mode each node drives the recipes with `runSync`, sending every request
through CRE's HTTP client with `cacheSettings: { store: true, maxAge: "300s" }`
(the SDK 1.22.0 shape; `{ readFromCache, maxAgeMs }` from the docs does not
typecheck) and the key added per provider; then `underwrite()` derives the
Facts, and the DON agrees on them field by field:

```ts
import { accountRecipe, linkedRecipe, runSync, underwrite } from "@polarispay/underwriting/core";

const now = Math.floor(runtime.now().getTime() / 1000); // DON time, identical on every node
// `send` makes one provider request through CRE's HTTP client (the workflow's creSender, evidence.ts).
const send = creSender(nodeRuntime, req, log);
const account = runSync(accountRecipe(user, { now, accountBalance }), send);
// The linked wallet only when the buyer brought one ("Bring your history").
const linked = wallet ? runSync(linkedRecipe(wallet, { now }), send) : null;
const out = underwrite({ user, observedAt: now, account: account.evidence, linked: linked?.evidence ?? null, linkVerified });
if (!out.final) return; // no report: missing evidence is never attested as zero
if (!out.attest) return { status: "thin", gaps: out.decision.thinFile }; // a thin file: no report, no retry
runtime.report(prepareReportRequest(out.report)); // abi.encode(uint8 2, [(user, linkedWallet, Facts)])
```

The workflow itself runs both recipes at once with `all(...)` when there is a
wallet (`observe()` in `workflows/src/underwriting/evidence.ts`, the code to
copy). `linkVerified` is the workflow's own check of the wallet's signature over
`linkMessage(...)`, done before any provider call. The report the workflow
signs is the deployed `UnderwritingReceiver`'s batch,
`abi.encode(uint8 2, (address user, address linkedWallet, Facts)[])`, not
`encodeUnderwriteReport`'s single-item `(uint8, address, Facts)`; the Facts
words are the same.

## Known unknowns

Carried from docs/research/data.md §9, and handled defensively until checked
with real keys (`pnpm --filter @polarispay/underwriting record` prints each):
Nansen's `block_timestamp` format (the parser reads ISO with or without an
offset, unix seconds and milliseconds), `first_funder_name` for exchanges
(matched as a whole word anywhere in the label), the `relation` vocabulary
(every relation is counted), Zerion's `monad-test-v2` coverage (Etherscan
`tokentx` is the fallback), and Aave-compatible pools on Monad mainnet (none
are allowlisted yet, so none count).

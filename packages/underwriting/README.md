# @polarispay/underwriting

**The credit decision behind Pay in 4 on Arc.** It reads a buyer's Polaris
account on Arc, plus a history wallet they linked on another chain, turns that
into `ScoreManager` Facts, and builds the report the Polaris keeper submits to
`UnderwritingReceiver.submitReport` on Arc. The same Facts give the product
decision the buyer sees: the line, whether Pay in 4 fits this purchase, what
would raise it, and why, in the buyer's words.

```
You can pay in 4 for up to $992.38.
  nansen     You've used your linked account for 3 years · +60
  zerion     You keep $4,237 on hand across your accounts · +42
  rpc        You've made 901 payments and transfers · +36
  zerion     You've used savings and trading apps for over 2 years · +24
  nansen     First topped up from Coinbase, a major exchange · +10
  etherscan  No past loans closed by a lender · +0
```

```bash
pnpm install && pnpm --filter @polarispay/underwriting test
```

The tests answer every provider from synthesized fixtures
([`fixtures/`](fixtures/README.md)), no keys needed. The fixtures are test
doubles behind `@polarispay/underwriting/testing`, which no product path
imports (`test/no-fixtures-in-product.test.ts` checks the package, the
gateway, the business and buyer apps and the keeper).

## Where the evidence comes from

| Evidence | Polaris account (Arc, keyless) | Linked wallet (mainnet history, keyed) |
|---|---|---|
| first seen | Arc explorer (Blockscout): oldest of `txlist` and `tokentx` | **Nansen first-funder** → Zerion probes |
| sent count | the larger of the RPC nonce and the transfers it sent in its last 100 (`tokentx`) | RPC nonces on Ethereum, Base and Arc mainnet → Zerion (capped at 100) |
| dollars held | RPC `balanceOf` on USDC and EURC (6 decimals each) | Zerion positions → Nansen current-balance |
| trading since | none by rule | Zerion probes → Nansen transactions (`dex`, last year) |
| liquidations | none by rule | Etherscan V2 logs, allowlisted Aave pools only |
| funder, cluster, risk label | none by rule (Polaris pays the gas) | **Nansen first-funder, related-wallets**, labels when enabled |

A Polaris account rarely sends a transaction itself: Polaris relays what it
signs and pays the gas, in USDC. So its history is read from both of the
explorer's lists, and its sent count from the transfers it signed as well as
its nonce. On Arc a plain USDC transfer also emits the ERC-20 `Transfer`
event, so `tokentx` sees it. EURC counts at one dollar a euro (conservative
while the euro trades above the dollar). The explorer API is Blockscout's
Etherscan-style one, keyless:

```
GET https://explorer.testnet.arc.io/api?module=account&action=txlist&address=<a>&sort=asc&page=1&offset=1
→ { "message": "OK", "status": "1", "result": [{ "timeStamp": "1761760791", "from": "0x…", ... }] }
→ { "message": "No transactions found", "status": "0", "result": [] }   (a known empty)
```

If the explorer fails, the account's age is `missing` and the outcome waits
(`final: false`); one list failing falls back to the other. If the account
chain has no explorer (a local node), the age is `not_configured` and the
nonce still counts.

A linked wallet is **admitted** only if its ownership was proven by signature
(`linkMessage`, checked with viem's `verifyMessage`), it carries no high-risk
label, and every risk check on it ran. **Missing data is never reported as
zero**: the outcome is `final: false`, `report: null`, and the preview never
counts an unchecked wallet.

### Keyed providers: live or not configured

Nansen, Zerion and Etherscan read the linked wallet only. With its key a
provider is `live`; without it, it is `not_configured`: never called, nothing
answers in its place, and the evidence only it reads is absent. A positive
field that is absent earns no points; an absent risk check (liquidations,
cluster, risk label, first funder) leaves the linked wallet out and the
outcome not final, with `unavailable: true` and no retry, until the key is
set. The account itself needs no key.

## Environment (`Underwriter.fromEnv`)

| Variable | Default | What it does |
|---|---|---|
| `UNDERWRITING_ACCOUNT_CHAIN_ID` | `5042002` | Where Polaris accounts live: `5042002` Arc testnet, `5042` Arc mainnet, any other id a custom chain (needs the two below) |
| `UNDERWRITING_ACCOUNT_RPC_URL` | `https://rpc.testnet.arc.io` (mainnet: `https://rpc.mainnet.arc.io`) | The account chain's RPC: balances and nonce |
| `UNDERWRITING_ACCOUNT_EXPLORER_API_URL` | `https://explorer.testnet.arc.io/api` (mainnet: `https://explorer.arc.io/api`) | The Blockscout API; `none` for no explorer (a custom chain has none unless set) |
| `UNDERWRITING_ACCOUNT_TOKENS` | Arc USDC `0x3600…0000` and EURC | Comma-separated 6-decimal dollar tokens whose balances count; required for a custom chain |
| `RPC_URL_1`, `RPC_URL_8453`, `RPC_URL_5042` | public endpoints | Override a history chain's RPC (Ethereum, Base, Arc mainnet) |
| `NANSEN_API_KEY` | unset | Live Nansen: first funder, related wallets, balance and trading fallbacks. Without it a linked wallet's risk checks cannot run |
| `ZERION_API_KEY` | unset | Live Zerion: exact balances, tenure probes, the age fallback |
| `ETHERSCAN_API_KEY` | unset | Live Etherscan V2: past liquidations on Ethereum, Arbitrum, Polygon |
| `NANSEN_LABELS` | unset | `1` spends 100 Nansen credits per linked wallet on its labels for the risk screen |
| `UNDERWRITING_ALLOW_PARTIAL` | unset | `1` reports conservatively instead of asking to retry |

`UNDERWRITING_MODE=fixture` is refused: there is no fixture mode.

## For the Polaris keeper

```ts
import { Underwriter } from "@polarispay/underwriting";

const uw = Underwriter.fromEnv();             // reads the variables above
const a = await uw.assess({
  account,                                     // the buyer's Polaris account (Address)
  linked: { wallet, proof: { issuedAt, nonce, signature } } /* or null */,
  purchase: 200_000_000n,                      // optional, 6-decimal base units
  activeDebt: 0n,                              // optional
});
if (!a.final) retryLater(a.retryAfterSeconds); // null: asking again cannot help (a key or a signature is missing)
else if (a.attest) await receiver.submitReport(a.report!); // abi.encode(uint8 2, [(user, linkedWallet, Facts)])
else /* thin file: no report, a.decision.thinFile says what is short */;
```

`Assessment` is the core's `UnderwriteOutcome` (`final`, `attest`, `report`,
`facts`, `missing`, `absent`, `unavailable`, `linkedWallet`, `breakdown`,
`decision`, `derivation`) plus `assessedAt`, `providers` (`nansen`, `zerion`,
`etherscan`, `rpc`, `blockscout`, each `live` or `not_configured`),
`notConfigured`, `evidence`, `linkProof`, `issues`, `retryAfterSeconds` and
`credits`. `a.facts.observedAt` is `assessedAt`; `ScoreManager` accepts
evidence up to 15 minutes old, so submit promptly.

## The score, the line and the thin-file gate

The score is `ScoreManager.scoreFromFacts`, mirrored exactly in BigInt
(`scoreFromFacts`, `scoreBreakdown`): floor 520; age `floor(days / 30) × 2` up
to 60; activity `floor(txCount / 25)` up to 50; 1 per $100 held up to 50;
1 per 30 days of trading up to 30; +10 first funded from an exchange; −75 per
prior liquidation; −2 per related wallet above 3, up to −80. Clamped to
300–739; declined at 2 liquidations or 25 related wallets. The line is
`ScoreManager.baseLimitOf`'s tier ($200 below 580, $500, $1,000 from 670); an
underwritten line never opens above $1,000.

`underwrite()` reports only facts that show a life: **at least 90 days and at
least 10 payments and transfers** across the account and an admitted linked
wallet, exactly `ScoreManager.isThinFile` (`ATTEST_MINIMUM`, `isAttestable`,
`attestGaps`). A thin file gets no report (the chain would refuse it with
`ThinFile`) and stays secured-only; a decline is reported even when thin.

## Entry points

- `@polarispay/underwriting/core`: pure and dependency-free (no Node API, no
  clock, no randomness, no `Intl`; `tsconfig.core.json` enforces it).
  `underwrite`, `deriveFacts`, `scoreFromFacts`, `decide`, `explainFacts`,
  `explainOnChainFacts`, `merchantVoice`, `poweredBy`, `encodeUnderwritingReport`,
  `decodeUnderwritingReport`, `linkMessage`, the recipes (`accountRecipe`,
  `linkedRecipe`, `runSync`, `runAsync`, `all`), the constants (`ARC_TESTNET`,
  `ARC_MAINNET`, `arcNetwork`, `HISTORY_CHAINS`, `SCORE`, `TIERS`,
  `ATTEST_MINIMUM`, ...) and each provider's request builders and parsers
  (`nansen`, `zerion`, `etherscan`, `rpc`, `blockscout`).
- `@polarispay/underwriting`: the core plus the Node side: `Underwriter`,
  `accountChainFromEnv`, the clients (`NansenClient`, `ZerionClient`,
  `EtherscanClient`, `RpcClient`, `BlockscoutClient`; retries, rate limits,
  a 10-minute cache keyed without secrets), `collectAccount`, `collectLinked`,
  and the HTTP API (`createRouter`, `createNodeHandler`, `createFetchHandler`,
  `startUnderwritingServer`).
- `@polarispay/underwriting/client`: a typed `fetch` client for the HTTP API
  that [`apps/gateway`](../../apps/gateway/README.md) serves (`/health`,
  `POST /v1/underwrite`, `POST /v1/explain`, `GET /v1/link-message`). Server
  side only: it carries the gateway's bearer token.
- `@polarispay/underwriting/testing`: the fixture transport, for tests only.

```bash
pnpm --filter @polarispay/underwriting typecheck
pnpm --filter @polarispay/underwriting test
pnpm --filter @polarispay/underwriting fixtures:synthesize   # rewrite fixtures/ from the personas
NANSEN_API_KEY=… ZERION_API_KEY=… ETHERSCAN_API_KEY=… pnpm --filter @polarispay/underwriting record --linked 0x… --account 0x…
```

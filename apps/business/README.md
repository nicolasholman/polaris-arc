# Polaris for Business

The merchant side of Polaris (`@polaris/business`): the merchant landing,
sign-in with Privy, the dashboard (payment links, payments, the Pay in 4
ledger, payouts, API keys and webhooks) **and the backend every Polaris
payment goes through**. The web app follows ref E
([`docs/design/refs-v2/ref-e-lumatrade.png`](../../docs/design/refs-v2/ref-e-lumatrade.png)):
a dark panel floating on a lime canvas, a top nav, the gradient sales chart
and the WITHDRAW / REQUEST widget. Every screen is composed from
`packages/ui` ([`docs/design/system.md`](../../docs/design/system.md), "Web
dashboard"); captures of every page are in
[`docs/design/web-v2`](../../docs/design/web-v2).

The backend:

- **the relayer**, a policy-locked Privy server wallet that carries every
  buyer action to Monad, so nobody but us ever holds MON;
- **the checkout API** that `polarispay-sdk` calls (`/api/v1/checkout/sessions`),
  with `sk_`/`pk_` keys and idempotency keys;
- **signed webhooks** with retries and a delivery log, built only from chain
  events;
- **merchant onboarding** on chain (`MerchantRegistry.registerFor`, signed by
  the merchant's embedded wallet) and **payouts**, one tap or automatic.

The plan is [`docs/plan.md`](../../docs/plan.md) §3.2, §5.3, §5.7 and §5.8;
the Privy details are in [`docs/research/privy.md`](../../docs/research/privy.md).

## Run it

```bash
pnpm install
pnpm --filter @polaris/business dev                       # http://localhost:3100
pnpm --filter @polaris/business e2e:local                 # the whole backend on a local chain (below)
```

Without `NEXT_PUBLIC_PRIVY_APP_ID`, /login and /dashboard show a setup screen
(in development it says what to configure; in production it only says sign-in
is unavailable) and every dashboard route answers 503. The landing page and
`pnpm --filter @polaris/business build` work either way.

## Pages

| Path | What |
|---|---|
| `/` | The merchant landing, "Polaris for Business". Signed-in merchants see **Open dashboard** in its nav. |
| `/login` | Sign in: one **Continue** that opens Privy's modal; the first time, the business name, then its registration on Monad. |
| `/dashboard` | Overview: sales with a sparkline and delta, customers this week, sales by mode, daily payment volume candles, recent sales, credit exposure with Nansen-backed reasons, the Chainlink CRE collections run, the Envio event feed, and the registration banner until the business is active. |
| `/dashboard/payments` | Every payment; rows open a detail drawer. |
| `/dashboard/links` | Payment links: create (dialog), share with a QR code, turn off. |
| `/dashboard/plans` | The Pay in 4 ledger with instalment ticks; rows open a plan drawer. |
| `/dashboard/payouts` | The balance card, one-tap withdraw (review, confirm, receipt), automatic daily payouts with **Pay out now**, history. |
| `/dashboard/chainlink` | The three Chainlink CRE workflows as they run (More > Chainlink, and the Overview's collections card): the risk guard's verdict, its checks against the thresholds and how old its last check is; the pool-health feed (`GuardianReceiver.latestRoundData`, "computed by CRE"); each workflow's triggers and latest reports on Monad, each with its transaction and what it did; how reports reach the receivers. On a server with nothing deployed it says so, and shows nothing else. |
| `/dashboard/developers` | The integration (merchant ID, `baseUrl`, registration), API keys, webhooks with a test event and the delivery log (attempts, **Retry now**), the SDK snippet, the demo shop. |
| `/gallery` | Every `@polaris/ui` component, beside the reference it reproduces. |

The dashboard used to live at the top level: `/payments`, `/links`, `/plans`,
`/payouts` and `/developers` (and anything under them) redirect to
`/dashboard/…` (`next.config.ts`). Detail views open in a right-hand drawer and
create flows in a dialog; below 768px both are bottom sheets.

"See the demo shop" opens Halcyon (`apps/shop`, a store on polarispay-sdk) at
`NEXT_PUBLIC_DEMO_SHOP_URL`, or `http://127.0.0.1:3600` in development
(`pnpm dev:demo` at the repo root runs both apps). In development the buttons
check the shop answers first, so with the shop stopped they read "Demo shop
coming soon" instead of opening a refused connection. A production build
without it shows them disabled, never a link to the visitor's own localhost.

## Privy: sign-in and the payout wallet

The web app never draws a sign-in button of its own for any method. The
sign-in page's **Continue** calls Privy's `login()`, and Privy's modal lists
exactly the methods turned on for the app in the Privy dashboard.

As configured today (checked against the Privy app, not changed here):

- **Email** is on, and **external wallets** are on.
- **Google is off.** To offer it, turn it on in the Privy dashboard (Login
  methods > Socials > Google); it then appears in the modal by itself, with no
  code change.
- **Allowed domains is empty**, which lets every origin use the app id. Before
  launch, add `http://localhost:3100` and the production domain under
  App settings > Domains.
- The client asks Privy for an embedded wallet for every merchant
  (`embeddedWallets.ethereum.createOnLogin: "all-users"` in
  `src/components/auth/privy-auth.tsx`), including one who signs in with an
  external wallet: the server only pays out from, and registers, the embedded
  wallet. Until Privy reports it, the dashboard polls `/api/me`.

The Privy modal carries the team's wordmark (`packages/brand/assets/wordmark.png`)
and our surface and lime colours. If Privy can't be reached for 8 seconds
(offline, a blocker, a firewall), /login and /dashboard say so and offer Retry.

`NEXT_PUBLIC_PRIVY_ANDROID_CLIENT_ID` belongs to the consumer app's Android
build. Never pass it as this web app's `clientId`.

## What the dashboard shows, and when

Pages read `DashboardData` (`src/lib/data/source.ts`) and nothing else; in a
real session it is implemented over this server's routes (`http.ts`).

- **What works is decided by the server.** `GET /api/health` says whether a
  chain, the relayer, the payout signer, the checkout origin and the public
  URL are set (and `ready` for production, never the list of what's
  missing: that is logged at startup); `useReadiness()`
  (`src/lib/features.ts`) turns that into a reason per control. Withdraw,
  automatic payouts, link sharing and registration are disabled with that
  reason beside them until they can work; nothing is left to fail, and nothing
  claims money moved when it didn't. If the health read fails, the controls
  say so and it is retried every 10 seconds (it has its own rate-limit
  bucket). Withdraw is also disabled on a $0.00 balance, and without a
  payout address its lime button chooses one.
- **No invented data.** Everything on the dashboard comes from the API, which
  reads the chain. With no chain configured, a merchant's book is empty and
  the money controls say the server isn't connected to Monad; an empty page
  says what to do next ("Your dashboard fills in as payments settle", "No
  payments yet"). A merchant record that an older build seeded with a sample
  book (`MerchantRecord.sample`) is cleared on its next request, with the
  withdrawals recorded against it.
- **The sponsor panels** read typed functions in `src/lib/data/insights.ts`:
  `getCollectionsRun` shows the Chainlink CRE workflow's real heartbeat
  (`Overview.collector`) once it reports, and "No collections run yet"
  before; `getIndexedEvents` (Envio) shows "Indexer not configured" without
  `POLARIS_INDEXER_URL` (or this server's chain sync, labelled, when it has
  events) and "The indexer didn't answer" when it is down;
  `getUnderwritingReasons` (Nansen) says nothing has reported until a CRE
  underwriting decision exists. The Chainlink page says "Nothing is deployed
  on this server yet" without a deployment.
- **Sessions end cleanly.** A 401 from any request signs out, says "Your
  session ended. Sign in again." and goes to `/login?next=<the page>`; a
  refresh that fails while older data is on screen shows its age and Retry;
  **Sign out** goes to `/login` with no `next`.

### Sign-in modes

There are two, and only the first exists in a production build:

1. **Privy** (`NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`): the real one.
   The server verifies Privy's access token on every dashboard route.
2. **The demo:local session** (`POLARIS_LOCAL_SESSION_TOKEN` and `_WALLET`
   on the server, `NEXT_PUBLIC_POLARIS_LOCAL_SESSION`, `_WALLET` and `_KEY`
   in the browser), which `pnpm demo:local` sets: the real API, signed in as
   the seeded merchant with a random token. The server accepts it only
   outside production, on a local chain (31337), with
   `POLARIS_DISABLE_PRIVY=1` (`src/server/env.ts` `localSessionFrom` throws
   otherwise), and `next.config.ts` blanks the public variables outside
   `next dev`.

## Web app code map

```
src/app/(privy)/page.tsx          the landing (components/landing, components/motion)
src/app/(privy)/login             sign in, name the business, register it on Monad
src/app/(privy)/dashboard/*       the pages (overview, payments, links, plans, payouts, developers, settings), behind the gate in dashboard/layout.tsx
src/app/(privy)/layout.tsx        Privy (AuthProvider) and the data source: only this group mounts them
src/app/gallery, not-found.tsx    no Privy
src/components/auth               Privy, the unconfigured state and the demo:local session, behind one AuthContext
src/components/shell              ref E's frame and top nav (More: Developers, Settings), the wallet pill and the account menu
src/components/dashboard          the money widget (WITHDRAW / REQUEST), PageHead and FigureRow, panels, status pills, the registration banner
src/components/landing            the landing's sections, its frame and nav, and the live product preview (preview.tsx)
src/lib/data                      DashboardData, types, formatting, analytics, insights.ts
src/lib/payouts.ts                useWithdraw, useAutoPayouts, useRegisterMerchant
src/lib/features.ts               readiness: which money controls work, and why not
```

## The local end-to-end run

`pnpm --filter @polaris/business e2e:local` starts a Hardhat node (`:8610`),
deploys every contract with the testnet deploy script, starts this server
(`:3530`) with the dev relayer adapter, seeds a merchant, and then, with the
real `polarispay-sdk`: creates a checkout
session (and replays it with its Idempotency-Key), pays it now through
`/api/relay` as a buyer with no MON, opens a Pay in 4 plan after a hand-built
underwriting report (the receiver's format, pushed through the local mock
forwarder: no CRE workflow runs here), pays through the SDK's direct-pay
relay, collects instalment 1 with a hand-built collections report, and checks
that `payment.succeeded`,
`plan.opened` and `installment.collected` arrive at a local receiver and verify
with the SDK. Nothing touches Privy, a public chain, or any account.

Other commands (`pnpm --filter @polaris/business <cmd>`):

| Command | What it does |
|---|---|
| `dev` | The landing, dashboard and API on http://localhost:3100 |
| `test` | 312 unit and route tests (vitest, on SQLite in memory; 2 more against a live indexer are opt-in): validation, auth, idempotency, the relayer's policy and signature checks, chain ingestion, webhook signing and retries, the Envio outbox reader, payouts, onboarding, the web audit's fixes (link turn-off, JSON 404/405, field errors, checksums, the write limit) and the web review's (an empty book without a chain, subscribe links, the active-link cap, registration catching up, health, malformed cookies, `next`) |
| `lint` | ESLint, then `scripts/check-api-auth.mjs`: every route must be exported through the authentication its path requires |
| `typecheck`, `build` | `tsc --noEmit`; `next build` |
| `dev:merchant` | Create a local merchant with `sk_test_`/`pk_test_` keys (and a webhook endpoint) without Privy |
| `privy:setup-relayer` | Create the relayer wallet and its policy in your Privy app (dry run unless `-- --apply`) |
| `privy:setup-payouts` | Create the payout signer for automatic payouts (dry run unless `-- --apply`) |
| `privy:prove-policy` | Ask Privy to sign the allowed calls and the forbidden ones, and show what it refused (`-- --run`) |
| `privy:smoke` | One $0.50 Pay now through the Privy relayer against a running server (`-- --run`) |
| `smoke:testnet` | Every buyer and merchant action on Monad testnet through the relayer (the Privy server wallet once it is set up), with fresh accounts that never hold MON; writes [`docs/demo/testnet`](../../docs/demo/testnet/README.md) (`-- --run`) |

## How a payment flows

```
merchant server ──polarispay-sdk──► POST /api/v1/checkout/sessions (sk_test_)  ──► session cs_test_…
buyer (Polaris app) ──────────────► GET  /api/public/sessions/cs_test_…         ──► price, modes, on-chain terms
buyer signs (Face ID, no gas) ────► POST /api/relay {type: "pay" | "openPlan" | "subscribe", …}
   relay.ts: rebuild the typed data, check the signature, check it against the session
   submit.ts: policy check → eth_call simulation → estimateGas + 15% → nonce lane → Privy signs → broadcast
   ingest.ts: the receipt's own events → session complete → records → webhook events
merchant server ◄── POST https://merchant/webhook (Polaris-Signature: t=…,v1=…) ── dispatcher.ts, with retries
```

"Paid" only ever comes from a transaction's events: the relayer's receipt, or
the chain sync (`ingest/sync.ts`) for everything the relayer didn't send (CRE
collections and renewals, liquidations, a buyer paying from their own wallet).
Each log is handled once, whichever path sees it first. Set
`POLARIS_LOGS_RPC_URL` to Envio's HyperRPC for Monad and the chain sync reads
its logs from Envio's index, 10,000 blocks a request instead of the public
RPC's 100, so the dashboard, payouts, the buyer's book and every webhook run
on Envio data.

A session's order id is public, so anyone can settle that order on chain some
other way. Two things stop that from counting as paid:

- every session's price is pinned on chain (`PolarisPayments.quoteOrder`, sent
  by the relayer on its operator role) before the session is returned, so
  every payment path reverts on any other amount;
- ingest completes a session only when what settled its order matches it
  (amount or principal, a mode it offers, its own plan and period). Anything
  else is kept on the session as a `mismatch`, never completes it, never
  counts on its payment link and sends no `payment.succeeded`.

The SDK's direct-pay relay (`/api/v1/relay/payments`) refuses an order id that
belongs to a checkout session, and one PolarisCheckout already settled.

## The relayer (plan §5.3, research §5.5)

`src/server/policy/relayer.ts` is the allow-list, and both enforcers read it:

| Call | Who signs | Why the relayer can't redirect it |
|---|---|---|
| `PolarisCheckout.pay` | buyer: ERC-3009 `ReceiveWithAuthorization` | nonce = `keccak256(merchant, orderId)` |
| `PolarisCheckout.openPlan` | buyer: `PlanIntent` + ERC-2612 `Permit` | the intent names merchant, amount, schedule, order |
| `PolarisCheckout.subscribe` | buyer: `SubscribeIntent` + `Permit` | the intent names plan, price, period |
| `PolarisPayments.payWithAuthorization` | buyer (SDK direct pay) | as `pay` |
| `PolarisPayments.cancelWithSignature` | subscriber | |
| `PolarisPayments.createPlanFor` | operator (server: a session's subscription terms) | publishes a plan for the session's own merchant; moves nothing |
| `PolarisPayments.quoteOrder` | operator (server: a session's price) | pins the session's price on its order before the order id is handed out; moves nothing |
| `PolarisSend.send` / `claim` / `cancel` | sender + link key / link key / sender | the link key's signature names the recipient |
| `PolarisSplit.createSplit` / `closeSplit` | organiser: `CreateSplit` / `CloseSplit` | the organiser signs the shares, the hash of the link's words and the expiry; a close names its split. Each share must be at least `RELAYER_MIN_TRANSFER_UNITS` |
| `PolarisSplit.payShare` | friend: ERC-3009 `ReceiveWithAuthorization` | nonce = `keccak256(splitId, index)`, value = the share's amount read from the chain; refused before any gas when the split is closed, expired or the share paid |
| `PolarisLoanEngine.repayWithSig` | borrower: `RepayIntent` | |
| `PolarisCheckout.reauthorize` | borrower: ERC-2612 `Permit` to the loan engine | the contract checks spender, signer and that the value covers everything owed; the relayer refuses first when nothing is owed, the approval already covers it, or the permit is short |
| `CollateralVault.lockWithPermit` | borrower: ERC-2612 `Permit` to the vault | the vault moves exactly the permitted amount into the borrower's own position, nowhere else; no fallback to a standing allowance (a secured Pay in 4 line with no MON) |
| `CollateralVault.withdrawWithSig` | borrower: `Withdraw` (the vault's own EIP-712 domain) | take out of Boost with no MON: the vault pays the borrower, never the caller, and nothing while a Pay in 4 plan is open. The relay (`withdrawCollateral`) asks the vault itself whether it takes signed withdrawals (`src/server/vault.ts`): Monad testnet's vault predates them, so there it answers `withdraw_unavailable` before anything is signed or sent. In the policy builder and its tests; **not yet applied to the live Privy policy** (it needs the admin key and the testnet go: [`docs/DEPLOY-LATER.md`](../../docs/DEPLOY-LATER.md)) |
| `MerchantRegistry.registerFor` / `updatePayoutAddressWithSig` | merchant's embedded wallet | the merchant signs name and payout address |
| AUSD `transferWithAuthorization` | owner (withdrawals, payouts) | the owner signs `to` and `value` |

1. **Privy** (`RELAYER_MODE=privy`): `privy:setup-relayer` builds the policy
   from that list: one `DENY` for any transaction carrying MON, then one
   `ALLOW` per call (`eth_signTransaction`, this chain, this contract, this
   function, function-only ABI fragments). Anything else matches no rule and
   Privy denies it in its enclave. The wallet and the policy are owned by an
   offline admin key quorum; the server's key is only an additional signer, so
   a stolen server key can't change the policy (research §7).
2. **Us**: `checkRelayerCall` applies the same list before anything is signed,
   so the local dev adapter (`RELAYER_MODE=local`, a raw key, local chains
   only) is held to exactly the production policy, and a call Privy would
   refuse fails here with a clear error.

Privy signs and we broadcast to our own RPC (research §4.3, route B): it works
on any EVM chain and lets us set the gas limit, which Monad bills in full.

`POST /api/relay` also: verifies every signature server-side before
simulating; refuses a signature for another amount, merchant, order or
schedule than the session's; relays the same signatures once (the relay id is
their digest); refuses a second settlement for a session while one is in
flight; maps contract errors to messages for the buyer (`ExceedsCreditLimit`
→ "This is more than your Polaris limit right now."); and rate-limits per IP
and per signing account.

### Setting it up (you run these; they create things in your Privy app)

```bash
pnpm --filter @polaris/business privy:setup-relayer                          # dry run: the plan and the policy JSON
pnpm --filter @polaris/business privy:setup-relayer -- --apply --registry-admin
# fund the relayer address it prints with ~1 MON, then give it its roles:
RELAYER_ADDRESS=0x… pnpm --filter @polarispay/contracts grant-relayer:monad
NEW_OWNER=0x… node apps/business/scripts/transfer-registry-owner.mjs --apply  # only with --registry-admin, after grant-relayer
pnpm --filter @polaris/business privy:setup-payouts -- --apply
pnpm --filter @polaris/business privy:prove-policy -- --run                   # the bounty evidence: what Privy refused
# with the server running on Monad testnet (RELAYER_MODE=privy), a merchant's sk_test_ key
# and a throwaway test buyer holding $0.50 of testnet AUSD:
POLARIS_SECRET_KEY=sk_test_… BUYER_PRIVATE_KEY=0x… pnpm --filter @polaris/business privy:smoke -- --run  # one real relayed Pay now
```

The scripts write the server's side to `apps/business/.env.privy`
(git-ignored); copy those lines into `.env.local`. The admin key quorum's
private key is written once to `apps/business/.privy-admin.key` (mode 0600,
git-ignored, never printed): move it offline and delete the file.

## Checkout sessions (plan §5.8)

Exactly the HTTP contract in [`packages/sdk/README.md`](../../packages/sdk/README.md#http-api):

| Route | Auth | |
|---|---|---|
| `POST /api/v1/checkout/sessions` | `sk_test_` | Validates like the SDK (same `code` and `param` on every error); `Idempotency-Key`: same key and body → the first session (200), different body → 409 `idempotency_key_reused`, still running → 409 `idempotency_in_progress`; 24 h expiry; the on-chain order id is your `orderId`, else the session id |
| `GET /api/v1/checkout/sessions/{id}` | `sk_test_` | Your own sessions only (others are a 404); `status` becomes `complete` only from a chain event, `expired` from time |
| `POST /api/v1/relay/payments` | `pk_test_` | The SDK's `pay()` relay: `PolarisPayments.payWithAuthorization` for the key's own merchant, any other contract or chain refused |
| `GET /api/public/sessions/{id}` | public | What the hosted checkout reads: price, modes, the Pay in 4 schedule and whether it's offered (and why not), the exact on-chain terms; `?buyer=0x…` adds that buyer's nonces and loan quote. No metadata, no secrets |
| `POST /api/public/links/{id}/checkout` | public | Opens a dashboard payment link as a fresh one-hour session |
| `GET /api/public/network` | public | Chain, contract addresses and EIP-712 domains, from the deployment record |
| `POST /api/relay` | the buyer's signature | Every buyer action (above) |

Secret keys are stored only as `HMAC-SHA256(POLARIS_KEY_PEPPER, key)`; the
server refuses to hash without the pepper in production. Every response
carries `Polaris-Request-Id`; errors are `{ error: { code, message, param? } }`.

## Webhooks

`src/server/webhooks`: every event is stored once (its id derives from the
chain log it came from), then one delivery per subscribed endpoint:

- signed exactly as `polarispay-sdk` verifies: `Polaris-Signature: t=<unix>,v1=<HMAC-SHA256(whsec_…, "t.body")>`,
  with `Polaris-Event` and `Polaris-Delivery-Attempt`; the body is identical on
  every attempt;
- retried on failure at 1 min, 5 min, 30 min, 2 h, 6 h, 10 h and 15 h (eight
  attempts), each attempt logged with status, time and the start of the
  response; retry any delivery by hand;
- an SSRF guard refuses private and loopback addresses at connect time, not
  just when the URL is saved;
- all nine events: `payment.succeeded`, `plan.opened` (with the schedule),
  `installment.collected`, `installment.failed` (following the dunning ladder:
  one event per rung, not per CRE run), `plan.completed`, `plan.liquidated`,
  `subscription.charged`, `subscription.canceled`, `payout.paid`, with the
  fields in the SDK's `events.ts`.

Dashboard routes: `GET/POST /api/webhooks`, `DELETE /api/webhooks/{id}`,
`POST /api/webhooks/{id}/test` (sent now, signed like a live event),
`POST /api/webhooks/deliveries/{id}/retry`.

### Where events come from: the chain sync, and the Envio indexer's outbox

Without `POLARIS_INDEXER_URL`, events come from this server's own chain path:
the relayed transaction's receipt and the chain sync (`ingest/`). With it,
`src/server/webhooks/outbox.ts` also reads the Envio indexer's `Activity`
outbox ([packages/indexer](../../packages/indexer/README.md)), one row per
polarispay-sdk event in chain order:

- **By cursor, five rows a page** (`activityAfter(cursor, 5)`, only rows the
  indexer has committed), up to 20 pages a pass, in the background loop every
  2 s and first in every `/api/cron/tick`. The cursor is stored in the SQLite
  store (`indexer_outbox`) after each page, so a restart resumes after the
  last row handled. The first read starts where the chain sync starts
  (`POLARIS_SYNC_FROM_BLOCK`, else the deployment's first block, else the
  indexer's current progress: no backfill).
- **The same events, never twice.** Each row becomes the event through the
  indexer client's `toWebhookEvent`, with what the chain doesn't know taken
  from this server's records as the chain sync takes it (the merchant's
  `mer_…` id, the checkout session, a plan's or subscription's order and
  session ids, a payout's id and kind), and is checked with polarispay-sdk's
  `validateWebhookEvent` before it is stored. It goes through the same
  `emitEvent` under the same id (`evt_` + sha256 of
  `<txHash>:<logIndex>:<type>`; a payout keys on its payout record), so
  whichever path sees a chain event first stores it and queues its
  deliveries, and the other finds the id taken and sends nothing. Signing,
  retries and the delivery log are unchanged.
- **The same refusals.** A settlement that doesn't pay its session sends no
  `payment.succeeded` or `plan.opened`; rows for wallets that aren't
  merchants here, and payouts this server didn't make, are skipped. A row
  whose event fails the SDK's check, or that an older indexer wrote
  incomplete, is refused and logged, and the cursor moves on (the chain sync
  still sends that event from its own logs).
- **Which source fed each delivery** is in the dashboard's delivery log
  (an "Envio" or "Chain sync" pill, and "Source" in the delivery's drawer)
  and on `GET /api/webhooks` (`source` per delivery, `feed.mode`).
- **An indexer that doesn't answer** is a fallback, not an outage: the read
  is recorded, retried after 15 s, the chain sync carries on alone, the
  delivery log says so, and `GET /api/health` reports `webhooks.source:
  "fallback"` and, for the operator (`Bearer <CRON_SECRET>`), a problem
  naming it (the endpoint itself is never repeated; it can carry a key).
  `/api/health/ready` doesn't wait on it.

Tested in `test/outbox.test.ts` against a test double of the indexer's
GraphQL endpoint (paging, committed rows, the start block, a restart on a
SQLite file, dedupe both ways and inside one tick, payouts, refusals, all
nine kinds through the SDK's validator and signature check, an unreachable
indexer through the fake and through the real client, an indexer of another
chain). `test/outbox.live.test.ts`
runs the same reader against a live indexer, skipped unless
`POLARIS_INDEXER_LIVE_URL` and `POLARIS_INDEXER_LIVE_MERCHANT` are set (as for
`insights.live.test.ts`, [packages/indexer](../../packages/indexer/README.md#what-ran-on-6-oct-macos-docker-desktop)).
It has not been run yet: the dispatcher has not read a live indexer.

## Merchants, onboarding and payouts

- **Authentication**: every dashboard route verifies the Privy access token
  server-side (`@privy-io/node`) and reads the merchant's embedded wallet from
  Privy; nothing a client sends can name the merchant or their wallet. A user
  Privy no longer has is a 401 `invalid_token`; a refused app secret is a 503
  `auth_not_configured`; a malformed `privy-token` cookie is a 401, never a
  500. Dashboard writes are rate limited per merchant, and unknown `/api`
  paths answer a JSON 404. Every route declares GET, POST, PUT, PATCH and
  DELETE, the ones it doesn't support through its wrapper and
  `methodNotAllowed`, so they answer a JSON 405 (`pnpm lint` checks it).
- **Links**: `GET/POST /api/links` (at most 500 active per merchant;
  turned-off links don't count) and `PATCH /api/links/{id}` with
  `{ "active": false }` to turn one off; an inactive link opens no checkout
  (410 `link_inactive`). A single-use link can't offer Subscribe (400,
  `param: "usage"`). A link's URL follows the current
  `POLARIS_CHECKOUT_ORIGIN`.
- **Onboarding** (a registration left at `submitted` is checked against the
  registry on each `GET /api/me`, and the dashboard polls while it's in
  flight; after an activation error it offers **Retry activation**):
  `GET /api/merchant/registration` returns the
  `Registration` typed data for the embedded wallet to sign;
  `POST` verifies it and relays `registerFor`, then (with `REGISTRY_ACTIVATOR`)
  activates the merchant for Pay in 4 at the cap, once it has settlement
  history: Pay-now orders from `MERCHANT_ACTIVATION_MIN_PAYMENTS` different
  customers (3 in production), re-checked on each payment. Until then it
  takes Pay now only, so a crowd of fresh accounts can't draw their opening
  credit lines on a merchant that has never sold anything. The client hook
  is `useRegisterMerchant()` in `src/lib/payouts.ts`.
- **One-tap withdraw**: `POST /api/payouts` with the wallet's
  `TransferWithAuthorization`; the server rebuilds it from the amount and
  destination, checks the signer and the balance, and relays it.
- **Automatic payouts**: `POST /api/payouts/automatic` creates the merchant's
  own Privy policy (only AUSD, only this chain, only from their wallet, only to
  their payout address, at most $10,000 per payout); the browser adds our
  payout signer under it (`useSigners().addSigners`). The daily sweep (and
  `POST /api/payouts/automatic/run`) signs with that signer and the relayer
  submits it; it refuses to run if the wallet no longer lists our signer with
  that exact policy.

## Credit: firing the CRE underwriting workflow (plan §5.5)

ScoreManager opens an unsecured Pay in 4 line only from a CRE underwriting
report, and the workflow runs on an HTTP trigger. The product fires it:

1. `GET /api/public/credit/{account}/messages[?wallet=0x…]`: the exact texts
   to sign, with a fresh nonce: the account's consent (the workflow's
   `underwriteConsentMessage`) and, to bring history, the wallet's link proof.
2. `POST /api/credit/underwrite` with both signatures. The API verifies them
   (so no one can queue runs for someone else's account or spend the
   trigger's rate limit), refuses an account already underwritten, limits
   each account to a few tries a day, and queues the run. The DON verifies
   the signatures again, so the API can't underwrite anyone who didn't ask.
3. A worker loop (and `/api/cron/tick`) sends the queue to
   `CRE_UNDERWRITING_TRIGGER_URL` as `{ "input": payload }`, one run per
   `CRE_TRIGGER_MIN_INTERVAL_MS` (CRE fires an HTTP trigger once per 30 s).
   Under simulation that is `cre workflow simulate ./underwriting --listen
   --broadcast`, at `http://localhost:2000/trigger`.
4. The workflow's signed callback, `POST /api/cre/callback`
   (`Polaris-Signature`, HMAC with `POLARIS_CRE_CALLBACK_SECRET`), records
   `credit.underwritten`, `credit.refused` or `credit.thin`; a
   `collections.run` callback runs the chain sync at once.
5. `GET /api/public/credit/{account}`: the line and score from ScoreManager
   now, the latest request, and the workflow's decision with its reason.
   With `UNDERWRITING_GATEWAY_URL`, the decision also carries the buyer's
   reasons, line by line with the provider behind each (Nansen, Zerion):
   the facts the DON attested are read from the report in the forwarder
   transaction and explained by the gateway's `POST /v1/explain`, once.

## What the Polaris app reads

- `GET /api/public/sessions/{id}[?buyer=0x…]`, `POST /api/public/links/{id}/checkout`:
  the hosted checkout (with the buyer's nonces, Pay in 4 quote and the
  Subscribe permit value that keeps their other subscriptions funded).
- `GET /api/public/buyers/{address}`: the buyer's plans, subscriptions and
  payments to Polaris merchants, from chain events, with only what the chain
  already shows (no descriptions, order ids or metadata); every other dollar
  in or out (`moves`, with `split-paid` and `split-received` naming the
  split and the share); `splits`, the split-the-bill links the address
  organised; and `receipts`, which rows have a receipt sealed to the buyer
  (id, kind, transaction, amount; never what is in one).
- `POST /api/receipts/inbox`, `POST /api/receipts`: receipts only the buyer
  can read (below).
- `GET /api/public/splits/{id}`: a split-the-bill link's status for its page:
  PolarisSplit's `splitOf`/`sharesOf` read now (who organised it, each
  share's amount and payer, open, settled, closed or expired), with when each
  share was paid and in which transaction from the chain sync's `splits`
  records (`src/server/split.ts`). The split's words (what it's for, the
  names) travel in the link's fragment and never reach this server; the
  response carries their hash (`memoHash`) for the app to check them against.
  A deployment that predates PolarisSplit answers `503 split_unavailable` on
  the relay and `contracts.split: null` on `/api/public/network`.
- `GET /api/public/credit/{address}` and `/messages`, `POST /api/credit/underwrite`:
  credit (above).
- `GET /api/public/network`: the contracts and EIP-712 domains.
- `GET /api/public/credit-guard`: the risk guard (below).

## Receipts only the buyer can read

The buyer's Face ID derives an X25519 inbox key pair beside the wallet key
([`@polaris/receipts`](../../packages/receipts/README.md),
`docs/research/mera.md` §16). The server keeps what was bought only as
ciphertext sealed to it (`src/server/receipts.ts`):

- `POST /api/receipts/inbox` `{ address, inboxPublicKey, signature }`: the
  account's EIP-191 signature over `Polaris receipts key <inboxPublicKey>` is
  the credential (a passkey ceremony proves nothing to a server). Stored in
  `receipt_inboxes`. Registering also seals whatever this buyer's records
  still hold in the clear (what settled before they registered).
- **At settlement** (`ingest/ingest.ts`): Pay now, a Pay in 4 plan opening, a
  subscription starting, each subscription charge and each collected
  instalment write a sealed receipt (`sealed_receipts`: `enc` and `ct`,
  RFC 9180 HPKE, AAD `polaris.receipt.v1|<owner>|<id>`) when the payer has an
  inbox. Then the session's description and line items, and the payment's
  and plan's descriptions, become `Sealed for the buyer`
  (`SEALED_DESCRIPTION`); the session records `sealedAt`. An instalment's or
  a charge's receipt points at its plan's or subscription's
  (`refersTo`). A settlement that doesn't pay its session is never sealed to
  its payer.
- `POST /api/receipts` `{ address, issuedAt, signature }`: the account's
  signature over `receiptsReadMessage(address, issuedAt)`, at most five
  minutes old; answers that account's sealed receipts, newest first.
- **What stays in the clear:** what the chain shows anyway (payer, merchant,
  amount, time, transaction), the merchant's order id and metadata, a payment
  link's title and a subscription plan's name (the merchant's catalogue).
  The copy of the session an `Idempotency-Key` replays is sealed with it.
  Buyers without an inbox (email accounts, which have no PRF) keep today's
  records.
- **What the merchant sees:** its dashboard and `GET
  /api/v1/checkout/sessions/{id}` show `Sealed for the buyer` in place of the
  description once a sealed payment settles; its own order id stays.

Tested in `test/receipts.test.ts` (registration and forged keys, Pay now and its idempotent replay,
Pay in 4 with a collected instalment, a subscription and its charge, the
backlog, swapped rows failing to open, no plaintext anywhere in the store
after settlement, the read route's signature and freshness).

## Chainlink: the risk guard, signing again, and what each CRE report did

- **The risk guard.** `GET /api/public/credit-guard` (`src/server/cre/guardian.ts`)
  reads `PolarisCheckout.creditPaused()`, which is what `openPlan` applies,
  and GuardianReceiver's `creditStatus`, `currentInputs` (the pool as the
  receiver reads it, the thresholds, the acknowledged bad debt),
  `latestAttestation` and `latestRoundData`, once per 10 s per process.
  States: `open`, `paused` (with the reasons and "Pay in 4 is paused by our
  risk guard; pay now works as usual."), `stale` and `never` (the price check
  is late and blocks nothing: it fails open; the pool's checks still apply),
  `unconfigured`, `unavailable` (a failed read, treated as open, as the
  contract treats a guard it can't read). Each check says where its figure
  comes from: the price from the latest CRE attestation, the cash and bad
  debt from the pool itself, live. When PolarisCheckout asks another guardian
  than the deployment record names (a redeploy the API's env hasn't caught up
  with), its own `creditPaused()` still decides `paused`, and `mismatch`
  says so: the API never offers Pay in 4 the relay would refuse. The hosted
  checkout's `payIn4` carries it; the app, polarispay-sdk's
  `credit.guard()` (Halcyon) and the dashboard's banner read the route.
- **Signing again.** `POST /api/relay` type `reauthorize` carries a buyer's
  permit to `PolarisCheckout.reauthorize` after a collection failed with
  InsufficientAllowance. The buyer book (`GET /api/public/buyers/{address}`)
  says when a plan `needsSignature`, and `reauthorized` holds the
  Reauthorized transaction and, once it lands, the collection that followed.
- **What each report did.** The chain sync also reads UnderwritingReceiver,
  GuardianReceiver and PolarisCheckout's Reauthorized (`src/server/ingest/cre.ts`)
  and keeps one `cre_runs` record per report transaction, with the
  forwarder's ReportProcessed and the sender. A collections run that collects
  a buyer within 15 minutes of their Reauthorized is shown beside it (the
  instant retry). An UnderwritingApplied keeps its transaction on the
  account's credit decision, which `GET /api/public/credit/{account}` returns
  as `verified`, with who delivered it (`src/server/cre/provenance.ts`):
  `delivery` is `don` only for a report that came through Chainlink's
  KeystoneForwarder (DON-signed; "Verified by Chainlink CRE" in the app),
  `simulation` for the CLI's simulator through Chainlink's
  MockKeystoneForwarder ("Chainlink CRE (simulated)"), `local` on a local
  chain ("CRE workflow, local run"), `unknown` otherwise. The forwarder is
  the one the report's ReportProcessed named, else the one
  UnderwritingReceiver trusts. `GET /api/chainlink`
  (a merchant session) serves the dashboard page; a merchant sees its own
  buyers' addresses and its own share of each collections run only. The
  schedules come from the workflows' own configs (`workflows/<dir>/config.<CRE_TARGET>.json`,
  staging by default).
- **On `pnpm demo:local`**, the three workflows run for real on the local
  chain (`trigger:local`, `collections:local` with its log trigger,
  `guardian:local` reading Chainlink AUSD/USD on Monad mainnet), and
  `node scripts/demo-chainlink.mjs` does what a person would (the owner's
  demo threshold, a buyer's revoke). `pnpm demo:e2e:chainlink` plays it all
  headless: [`docs/demo/chainlink`](../../docs/demo/chainlink/README.md).
  Earlier captures of every state, with hand-built collections and guardian
  reports: [`docs/design/chainlink`](../../docs/design/chainlink).

## Environment

See [`.env.example`](.env.example) for every variable. The essentials:

| Variable | |
|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` | Sign-in; the dashboard routes answer 503 without them |
| `NEXT_PUBLIC_PRIVY_PAYOUT_SIGNER_ID` | The payout signer the browser adds for automatic payouts |
| `NEXT_PUBLIC_DEMO_SHOP_URL` | "See the demo shop" (`http://127.0.0.1:3600` in development, when it answers; disabled in production without it) |
| `POLARIS_DEPLOYMENT` / `POLARIS_DEPLOYMENT_FILE`, `POLARIS_RPC_URL` | Which contracts, which RPC |
| `RELAYER_MODE` (+ `PRIVY_RELAYER_*`) | `privy` in production, `local` on a Hardhat node, `off` |
| `POLARIS_KEY_PEPPER` | Required in production |
| `POLARIS_CHECKOUT_ORIGIN` | Where link and session URLs point (the Polaris app). Required in production: without it links don't go live and sessions answer 503 |
| `POLARIS_PUBLIC_URL` | This server's URL, signed into each merchant's registry metadata. Required in production: registration waits for it |
| `CRON_SECRET` | For `/api/cron/tick`, and for the list of production problems on `/api/health` |
| `POLARIS_INDEXER_URL` (+ `POLARIS_INDEXER_TOKEN`) | The Envio indexer's GraphQL endpoint: the Overview's "Indexed by Envio" feed, and the webhook outbox ([Webhooks](#where-events-come-from-the-chain-sync-and-the-envio-indexers-outbox)) |
| `CRE_UNDERWRITING_TRIGGER_URL`, `POLARIS_CRE_CALLBACK_SECRET` | The CRE underwriting trigger, and the secret its callbacks are signed with |
| `POLARIS_TRUSTED_PROXIES` | How many proxies append to `X-Forwarded-For` in front of this server (per-IP limits; `POLARIS_TRUST_PROXY=1`, the older setting, means 1) |

## Code map

```
src/app/api/**                 route handlers; each exported through one wrapper from src/server/auth.ts
src/server/auth.ts             Privy tokens, sk_/pk_ keys, signed requests, public, cron; errors → responses
src/server/env.ts              configuration, the deployment record
src/server/policy/             the relayer, registry-admin and payout policies (plain TS, shared with scripts)
src/server/relayer/            relay.ts (requests), carry.ts (bookkeeping), submit.ts (gas, nonces, broadcast), signer.ts (Privy / local)
src/server/sessions/           params.ts (the SDK's validation), idempotency.ts, sessions.ts
src/server/ingest/             ingest.ts (chain events → records + webhooks), sync.ts (the log poller, late receipts)
src/server/webhooks/           events.ts (emit), dispatcher.ts (deliver, retry), outbox.ts (the Envio indexer's Activity outbox)
src/server/payouts/            withdrawals and the automatic sweep
src/server/onboarding.ts       MerchantRegistry registration and activation (after settlement history)
src/server/credit/             CRE underwriting: the texts to sign, the request queue and trigger, the signed callbacks
src/server/receipts.ts         receipts sealed to the buyer's inbox key: registration, sealing at settlement, the backlog, reads
src/server/services.ts         the dashboard's reads and writes
src/instrumentation.ts         starts the background loops on a long-running server
packages/db                    the store, the record schema, key hashing, webhook signing and delivery
```

## Storage and deployment

The store is SQLite (`node:sqlite`, nothing to install) at
`POLARIS_DB_URL` (default `sqlite:.data/polaris.db`), and the relayer assigns
nonces in-process. So this app runs as **one long-lived Node process with a
persistent disk**: `next build && next start` on a VM, or the production
image ([`Dockerfile`](Dockerfile): a pruned workspace, Next's standalone
server as the `node` user, the store at `/data`) on Fly.io
([`fly.toml`](fly.toml): one Machine, a volume at `/data`) or Railway
([`railway.json`](railway.json)), behind one proxy
(`POLARIS_TRUSTED_PROXIES=1`). `GET /api/health/ready` is the readiness
check (the environment parses, a chain is configured, the store opens and its
folder is writable, the background loops run; no network call), and
[`docs/deploy.md`](../../docs/deploy.md) has every step. Serverless hosting (Vercel and the like) is
not supported as is: each instance would have its own nonce lanes and its
own (lost) database. Moving there means implementing `@polaris/db`'s `Store`
over Postgres and driving background work only through `/api/cron/tick`.

Background work runs in-process (`POLARIS_WORKERS`, default on outside
production; turn it on in production on a long-lived host), or from a
scheduler calling `POST /api/cron/tick` with `CRON_SECRET`.

Without a deployment record the dashboard still runs: a merchant's book is
empty, the money controls say the server isn't connected to Monad, and
nothing is relayed.

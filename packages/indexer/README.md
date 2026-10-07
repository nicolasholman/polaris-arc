# polaris-indexer

The [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview) indexer
for Polaris on Monad testnet (chain 10143). It turns every event of every
Polaris contract into the rows these read:

| Reader | What it asks | Breaks without it |
|---|---|---|
| **The CRE `polaris-collections` workflow** | Which instalments are due (or due a retry on the dunning ladder), which plans are past grace, which subscriptions renew: `DueCandidates` | The workflow proposes from the indexer and the chain disposes; without it, it falls back to scanning windows of ids and retries a failing buyer on every run |
| **The webhook dispatcher** (Polaris for Business, [`outbox.ts`](../../apps/business/src/server/webhooks/outbox.ts)) | The `Activity` outbox after a cursor: `payment.succeeded`, `plan.opened`, `installment.collected`, `installment.failed`, `plan.completed`, `plan.liquidated`, `subscription.charged`, `subscription.canceled`, `payout.paid` | Webhooks come from the API's own chain sync alone (the receipts of what it relayed, and its log reader) |
| **Polaris for Business** | Balance, payments, the Pay in 4 ledger with instalment tick marks and at-risk exposure, payouts, customers, daily bar and candlestick charts, CRE collector status | "Paid" only ever comes from indexed chain events, so the dashboard has nothing to show |
| **The Polaris app** | The buyer's credit line and why, open plans and the next payment, receipts, send links | The credit screen and "Arrived" on a claimed link |

HyperIndex V3 with `envio` **3.12.1** pinned; HyperSync is the data source
(`monad-testnet.hypersync.xyz`). Typed handlers, a GraphQL schema, 54 tests
including a replay of a real chain, an end-to-end run of Envio's own runtime
against a live local chain, a typed client ([`client/`](client/)) for
everything above, and one command that serves the GraphQL endpoint for a
local chain ([below](#graphql-for-a-local-chain-docker-for-postgres-and-hasura)).

## One command

The `envio` CLI has no Windows build, so everything runs on Linux or macOS:
WSL on Windows, a Linux or macOS machine, and CI. On 6 Oct `test` and `live`
(also with `POLARIS_LIVE_RUNS=5`) passed on macOS (Apple silicon, Node 26)
with the same script; nothing in it needed changing for macOS.

```bash
# from Windows, at the repo root (WSL distro with Node 22+ and pnpm inside it):
wsl -d <distro> -- bash packages/indexer/scripts/wsl.sh test

# from Linux or macOS:
bash packages/indexer/scripts/wsl.sh test
```

`test` installs this package on its own (it is deliberately outside the pnpm
workspace; see [Layout](#layout)), checks `config.yaml` is current with the
contract ABIs, runs `envio codegen`, type-checks, and runs the tests. No
Docker, no API token.

First time in WSL: Node must be a *Linux* install, not the Windows one WSL
puts on `PATH`. For example:

```bash
# inside WSL
mkdir -p ~/.local/opt
curl -fsSL https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz | tar -xJ -C ~/.local/opt
ln -sfn ~/.local/opt/node-v22.23.3-linux-x64 ~/.local/opt/node22   # scripts/wsl.sh puts ~/.local/opt/node22/bin first
~/.local/opt/node22/bin/npm install -g pnpm@10
```

Under WSL the Windows drives are slow, so when the repo is on `/mnt/c` or
`/mnt/e`, `wsl.sh` works in a copy on the Linux filesystem
(`~/.cache/polaris-indexer`: this package, the contract ABIs and deployment
records) and a run takes seconds. `POLARIS_INDEXER_IN_PLACE=1` turns that off.

The client's tests run anywhere, from the repo root:
`pnpm --filter @polarispay/indexer-client test`.

### The whole thing on a local chain, still without Docker

```bash
bash packages/indexer/scripts/wsl.sh live     # needs packages/contracts installed on Linux (pnpm install at the root)
```

A Hardhat node on port 3541; the contracts deployed with the testnet script;
the contracts' end-to-end flows plus `scripts/fixture-scenarios.cjs` run on
it; then Envio's own runtime indexes that chain over RPC (dynamic merchant
registration, the wildcard transfer filter, every handler) and the indexed
state must equal what the contracts report. It works in a scratch copy, so
`config.yaml` is untouched. `POLARIS_LIVE_RUNS=5` indexes the same chain five
times (CI does): Envio's queries answer in a different order every run, and
an ordering bug shows up only now and then. `POLARIS_FIXTURE_PORT` moves the
node off 3541.

This is Envio's runtime in-process (`createTestIndexer`): no database and no
GraphQL endpoint. For those, see the next section.

### GraphQL for a local chain (Docker for Postgres and Hasura)

```bash
pnpm indexer:local      # = bash packages/indexer/scripts/wsl.sh local (scripts/local.sh)
```

For a chain that is already running with the contracts deployed by
`scripts/deploy-monad.js` (`pnpm demo:local`'s on 8545, or any other):

1. Postgres and Hasura in Docker, the images and settings `envio dev` uses,
   but named `polaris-envio-postgres` and `polaris-envio-hasura` on their
   own network and ports, so they never meet another project's `envio dev`
   (which always names its containers `envio-postgres` and `envio-hasura`,
   on 5433 and 8080);
2. `config.yaml` regenerated for that chain with an RPC source, in a scratch
   copy (`generate.mjs --deployment <record> --rpc <url>`);
3. `envio start` in the foreground. Ctrl+C stops it and removes the
   containers, their network and the scratch copy; nothing is kept.

| Variable | Default | |
|---|---|---|
| `POLARIS_LOCAL_RPC` | `http://127.0.0.1:8545` | the chain |
| `POLARIS_LOCAL_DEPLOYMENT` | `packages/contracts/deployments/monad-local.json` | its deployment record |
| `POLARIS_INDEXER_GRAPHQL_PORT` | `18080` | Hasura: `http://127.0.0.1:18080/v1/graphql`, admin secret `testing` |
| `POLARIS_INDEXER_PG_PORT` | `15432` | Postgres |
| `POLARIS_INDEXER_METRICS_PORT` | `19898` | the indexer's own HTTP port (`/metrics`) |
| `POLARIS_INDEXER_DOCKER_PREFIX` | `polaris-envio` | container and network names |
| `ENVIO_BLOCK_LAG` | `0` | a local node mines only when sent something, so the usual 2 would hold back the last two blocks |

Then each reader points at the endpoint:

| Reader | Setting |
|---|---|
| Polaris for Business (the Overview's "Indexed by Envio" feed) | `POLARIS_INDEXER_URL=http://127.0.0.1:18080/v1/graphql` |
| Polaris for Business's webhook dispatcher | The same `POLARIS_INDEXER_URL`: it reads the outbox five rows at a time from its stored cursor ([below](#the-webhook-dispatcher-reads-the-outbox)) |
| The CRE collections workflow, run locally | `POLARIS_LOCAL_INDEXER_URL=http://127.0.0.1:18080/v1/graphql pnpm --filter @polaris/cre-workflows collections:local`: the real `onCron` takes its candidates from `DueCandidates` instead of scanning the chain, as a deployed workflow does with `candidates.indexerUrl` |

#### What ran on 6 Oct (macOS, Docker Desktop)

A Hardhat node on 18565; `node scripts/record-fixture.mjs --keep-node`
(`POLARIS_FIXTURE_PORT=18565`) deployed the contracts with
`deploy-monad.js` (MockAUSD, the demo merchant, the credit pool) and ran the
contracts' twelve end-to-end flows (underwriting, Pay now, two Pay in 4
plans, collection, early repayment, the guardian's pause and resume, a lost
approval signed again, a subscription and its renewal, a send and its claim)
and `fixture-scenarios.cjs` (a liquidation, payouts, a quoted order,
cancellations, a refund, a batch). Then
`POLARIS_LOCAL_RPC=http://127.0.0.1:18565 pnpm indexer:local` indexed it over
RPC: 119 events processed, synced to the head (block 90),
`_meta.isReady: true`.

Rows per entity, from GraphQL:

| Entity | Rows | Entity | Rows | Entity | Rows |
|---|---|---|---|---|---|
| Protocol | 1 | Subscription | 2 | ProtocolDay | 3 |
| Merchant | 2 | Send | 3 | BuyerDay | 5 |
| Buyer | 6 | Payout | 2 | ScoreEvent | 5 |
| Payment | 9 | Batch | 1 | Underwriting | 3 |
| Order | 8 | BatchLeg | 3 | LinkedWallet | 1 |
| Plan | 3 | Customer | 4 | CollectionRun | 6 |
| Installment | 12 | MerchantDay | 4 | CollectionTask | 7 |
| Repayment | 3 | SubscriptionPlan | 2 | CreReport | 9 |
| Activity | 21 | ConfigChange | 26 | | |

- **Equal to the chain.** Every loan's instalments paid, repaid and
  outstanding amounts and status, every subscription's periods and misses,
  each merchant's balance and each buyer's score, credit line and debt
  (27 values) equal what the contracts return over `eth_call`; the sends
  read `CLAIMED`, `CANCELLED`, `REFUNDED`.
- **The outbox.** 21 `Activity` rows, all nine webhook kinds:
  `payment.succeeded` 3, `plan.opened` 3, `installment.collected` 5,
  `plan.completed` 1, `installment.failed` 2 (one lost approval, one short
  balance), `subscription.charged` 3, `plan.liquidated` 1, `payout.paid` 2,
  `subscription.canceled` 1. Read the way the dispatcher reads them
  (`activityAfter`, five at a time, the cursor moved on with `nextCursor`),
  each turned into polarispay-sdk's event by `toWebhookEvent` and checked by
  the SDK's own `validateWebhookEvent` (`packages/sdk/src/event-shape.ts`):
  21 events, 21 distinct ids, none rejected.
- **`DueCandidates`.** At the chain's time, subscription #1 (a 60-second plan)
  was due and plan #2's next instalment a week away. With the node's clock
  set 30 seconds past that due time (inside the 2-minute grace), the
  workflow's query returned `Loan: [{ loanId: "2" }]` and
  `Subscription: [{ subId: "1" }]`. `collections:local` with
  `POLARIS_LOCAL_INDEXER_URL` then ran the real `polaris-collections` cron:
  "candidates from the indexer", 2 collected through `CollectionsReceiver`
  (instalment 2 of plan #2, a charge of subscription #1). The indexer picked
  up the result: plan #2 at 2 of 4 paid with its next due date a week on, a
  `Repayment` with `source: CRE` on time, a `CollectionRun` with 2 tasks
  executed, and two new outbox rows (`installment.collected`,
  `subscription.charged`) that the dispatcher loop, resuming from its cursor,
  read and validated.
- **Polaris for Business.** `apps/business/test/insights.live.test.ts`, the
  production path (`POLARIS_INDEXER_URL` through `getConfig()` to
  `merchantActivity` and `status`), passed against the endpoint for the demo
  merchant. It is skipped unless `POLARIS_INDEXER_LIVE_URL` and
  `POLARIS_INDEXER_LIVE_MERCHANT` are set:

  ```bash
  POLARIS_INDEXER_LIVE_URL=http://127.0.0.1:18080/v1/graphql \
  POLARIS_INDEXER_LIVE_MERCHANT=$(node -p 'require("./packages/contracts/deployments/monad-local.json").demo.merchant') \
    pnpm --filter @polaris/business test test/insights.live.test.ts
  ```
- **Every client document against a live Hasura.** All 22 of
  `@polarispay/indexer-client`'s calls (the dashboard's, the outbox's, the
  CRE's, the app's) answered without a GraphQL error and decoded, including
  `_meta` and the BigInt columns Hasura sends as strings.

The session ran twice with the same results (the second after the handlers
described under [Tests](#tests) were added). Not run: `next dev` for the
dashboard (the test above exercises its server code instead), and the API's
own webhook dispatcher, which on 6 Oct sent only what the API's chain sync
recorded. It reads the outbox since 7 Oct ([below](#the-webhook-dispatcher-reads-the-outbox)),
tested against a test double; its opt-in live test has not been run against
this endpoint yet.

### The webhook dispatcher reads the outbox

With `POLARIS_INDEXER_URL` set, Polaris for Business's dispatcher
([`apps/business/src/server/webhooks/outbox.ts`](../../apps/business/src/server/webhooks/outbox.ts))
tails `Activity` with `activityAfter(cursor, 5)`, five committed rows a page,
and stores the last row's cursor in its SQLite store after each page, so a
restart resumes after it. Each row becomes the merchant's event through
`toWebhookEvent`, with the session, order and payout details from the API's
own records, is checked with polarispay-sdk's `validateWebhookEvent`, and is
emitted through the same function as the API's chain sync, under the same
id. Both paths keep running (the chain sync also writes the API's records);
whichever sees a chain event first sends it, and the other finds its id
taken. Each delivery records which one fed it, and an indexer that doesn't
answer leaves the chain sync sending alone, reported on `/api/health`.
Details and tests: [apps/business README](../../apps/business/README.md#where-events-come-from-the-chain-sync-and-the-envio-indexers-outbox).
Not run against a live indexer yet; the opt-in test is

```bash
POLARIS_INDEXER_LIVE_URL=http://127.0.0.1:18080/v1/graphql \
POLARIS_INDEXER_LIVE_MERCHANT=$(node -p 'require("./packages/contracts/deployments/monad-local.json").demo.merchant') \
  pnpm --filter @polaris/business test test/outbox.live.test.ts
```

## Running it locally against Monad testnet (needs Docker)

```bash
cp packages/indexer/.env.example packages/indexer/.env   # add ENVIO_API_TOKEN from https://envio.dev/app/api-tokens
bash packages/indexer/scripts/wsl.sh dev                 # envio dev: Postgres + Hasura in Docker, hot reload
```

HyperSync for Monad testnet needs that token; we have none, so this has not
been run. Without one, the source can be an RPC instead, as the local runs
use: `node scripts/generate.mjs --rpc https://testnet-rpc.monad.xyz`
rewrites `config.yaml` with an `rpc:` source (do it in a copy, or restore
the file: the committed one uses HyperSync). Indexing testnet from the first
deploy block over a public RPC is slow and has not been tried.

GraphQL is then at `http://localhost:8080/v1/graphql` (Hasura console on
the same port, admin secret `testing`). On Windows, `envio dev` needs Docker
Desktop's WSL integration switched on for the distro (Settings > Resources >
WSL integration). `ENVIO_START_BLOCK` and `ENVIO_BLOCK_LAG` override
`config.yaml`.

## After the contracts are deployed

`config.yaml` and `src/deployment.ts` are generated, never edited:

```bash
pnpm --filter @polarispay/contracts deploy:monad     # writes packages/contracts/deployments/monad-testnet.json
node packages/indexer/scripts/generate.mjs           # rewrites config.yaml and src/deployment.ts from it
```

Commit both. Until that record exists every Polaris address is a marked
placeholder (`0x…cafe0001`…) and `src/deployment.ts` says
`placeholder: true`; AUSD and Chainlink's two CRE forwarders are real. The
start block is the first Polaris deploy block. `generate.mjs --check` (run by
the tests) fails if the files are stale, so a contract change cannot drift
from the indexer.

## Deploying to Envio Cloud (the hosted service)

Envio Cloud builds from a git branch and uploads only this folder, which is
why nothing here imports from outside it (`src/deployment.ts` is generated
into it) and `envio` is pinned exactly. Cloud needs no API token.

1. Sign in at <https://envio.dev/app/login> with GitHub, pick the
   organisation, and install the **Envio Deployments** GitHub App on the repo.
2. Add the indexer (dashboard, or the `envio-cloud` CLI, which runs natively
   on Windows):
   ```bash
   npx envio-cloud login
   npx envio-cloud indexer add --name polaris --repo polaris --branch envio --root-dir packages/indexer --config-file config.yaml --tier development
   ```
3. Push the branch it builds from: `git push origin HEAD:envio`. Each push
   re-indexes from the start block; the previous deployment serves until the
   new one is synced.
4. Wait and read the endpoint:
   ```bash
   npx envio-cloud deployment status polaris <commit> --watch-till-synced
   npx envio-cloud deployment endpoint polaris <commit>
   ```
5. Give that URL to every reader: `POLARIS_INDEXER_URL` for the dashboard and
   the webhook dispatcher, and `candidates.indexerUrl` in the CRE collections
   workflow's config, with `candidates.indexerQuery` set to the client's
   `DUE_CANDIDATES` document.

Free-plan limits to plan around: a deployment is deleted after 30 days
(hard limit); 100,000 events, 5 GB, or 7 days without a request (soft limits)
start a 7-day grace period, then 3 days read-only, then deletion; 3
deployments per indexer. Make the final deployment at the feature freeze (9 Oct), and keep it
queried: the CRE cron does while it runs, and
`.github/workflows/indexer-keepalive.yml` sends a daily `_meta` query once the
repository variable `POLARIS_INDEXER_URL` is set. The endpoint is
public on the free plan: nothing indexed is secret, and order ids must not
carry personal data.

## What is indexed

`config.yaml` lists every event of `PolarisCheckout`, `PolarisPayments`,
`PolarisLoanEngine`, `ScoreManager`, `MerchantRegistry`, `PolarisSend`,
`CollateralVault`, `BatchSettlement`, `CollectionsReceiver` and
`UnderwritingReceiver`, plus two sources that are not ours:

- **Chainlink's forwarders** (`CreForwarder`): `ReportProcessed` for our two
  receivers only (filtered by the receiver topic). `result: false` means the
  receiver reverted, which `cre workflow simulate` still reports as success.
- **Merchant accounts** (`MerchantWallet`): an account is registered at
  runtime when it registers with the `MerchantRegistry`, and from then on
  stablecoin `Transfer`s from or to it are indexed in wildcard mode, filtered
  at the source by topic. That gives the dashboard a balance without an RPC
  call, and makes payouts visible. Nothing else registers an account: Envio
  runs `contractRegister` as each contract's query answers, in any order, so
  an account registered from several events (a loan seen before the
  registration) could start being followed after its first payment; and
  paying an arbitrary account a cent must not make the indexer follow it.

| Entity | Holds | Read by |
|---|---|---|
| `Merchant` | Registration, totals by mode, Pay in 4 book (outstanding, dunning, at risk), MRR, balance, payouts | Dashboard |
| `Payment` | Every settled order and subscription charge, with the relayer that carried it | Dashboard, app |
| `Order` | An order key from quoted to paid, and whether it paid the quoted price | Checkout ("Paid"), dashboard |
| `Plan`, `Installment`, `Repayment` | Pay in 4 schedules, what was paid toward each instalment and by whom (buyer, CRE, keeper), dunning state | Dashboard, app, **CRE** |
| `SubscriptionPlan`, `Subscription` | Plans, subscriptions, next charge, misses, backoff | Dashboard, app, **CRE** |
| `Send` | Send-by-link from open to claimed, cancelled or refunded | App |
| `Payout`, `Batch`, `BatchLeg` | Merchant withdrawals; batch settlements with memos | Dashboard, webhooks |
| `Buyer`, `ScoreEvent`, `Underwriting`, `LinkedWallet` | The credit line (mirrors `creditLimitOf`), every score move and why, CRE underwriting results | App |
| `CollectionRun`, `CollectionTask`, `CreReport` | Every CRE report: tasks executed or skipped and why | Dashboard (collector card), evidence |
| `Activity` | The webhook outbox: one row per polarispay-sdk webhook, with everything its data needs and a strictly increasing `cursor` | Webhook dispatcher |
| `MerchantDay`, `ProtocolDay`, `BuyerDay` | Daily totals and candles (payment sizes, balance, score) | Charts |
| `Customer`, `Protocol`, `ConfigChange` | Merchant x buyer; protocol totals and settings; every role and setting change (e.g. exactly what the relayer may do) | Dashboard, evidence |

Envio Cloud exposes no aggregate queries, so every total is a counter kept at
indexing time. Money is BigInt in AUSD base units (6 decimals); times are Int
unix seconds; addresses are lowercase.

### How some of it is derived

- **Schedules without eth_call.** The loan engine's threshold ladder and
  `installmentsEarned` are mirrored exactly (`src/lib/loans.ts`), so
  `nextDueAt`, `liquidatableAt` (`nextDueAt + grace + 1`) and each
  instalment's paid amount follow from the events. Subscriptions mirror
  `chargeDue`, including the skip to the next boundary after a missed window.
  The engine's `LoanCreated` carries no interval, so a plan's schedule comes
  from `PolarisCheckout.PlanOpened`; the checkout is the only originator the
  deploy script appoints.
- **Dunning.** A skipped collection is decoded (`src/lib/revert.ts`):
  `InsufficientAllowance` = the buyer must sign again, `InsufficientBalance` =
  top up, `NotDue`/`LoanNotActive` = a stale candidate, nobody's fault. A real
  failure puts the plan into dunning and moves `nextAttemptAt` along the
  6 h / 24 h / 72 h / weekly ladder (`packages/keeperhub`), never past the
  liquidation point, so the workflow does not pay gas to retry a failing buyer
  every minute. A skip before that scheduled attempt (the workflow sweeping
  the chain while its indexer is down, another keeper) is the same miss, not a
  new one, as the API counts it: it is recorded as a `CollectionTask` but
  neither moves the buyer down the ladder nor writes another
  `installment.failed`.
- **Payouts.** A stablecoin transfer out of a merchant account in a
  transaction sent to the stablecoin itself (the relayer carrying the
  merchant's signed `transferWithAuthorization`) is a payout; money leaving
  through a Polaris contract (a checkout payment, a send) is not.
- **Totals by contribution.** Before a plan or subscription changes, its
  share of every total is noted; after, the difference is applied. The replay
  test checks totals against a recount.
- **Webhooks never fire from a handler** (handlers run twice and can be rolled
  back); they are rows in `Activity`. `block_lag: 2` (Monad's finality) means
  a row is final when it appears. The rows are exactly polarispay-sdk's nine
  events: `payment.succeeded` is Pay now only, a Pay in 4 order is
  `plan.opened` (with its schedule), a subscription is its
  `subscription.charged` rows (the first one learns its order from the
  checkout's `SubscriptionStarted`), and a repayment that completes several
  instalments writes one `installment.collected` per instalment. The client's
  `toWebhookEvent` turns a row into the SDK's event, and the replay and live
  tests run every row they index through the SDK's own `validateWebhookEvent`.
- **Merchant balances** count every stablecoin transfer since the merchant
  registered (`registeredAt`), which for a Polaris business is before any
  money. An account paid without ever registering is not followed: its
  `balance` stays 0 (read `AUSD.balanceOf`), and its payments still count in
  every volume.

## The GraphQL client

`@polarispay/indexer-client` (in [`client/`](client/)) is a workspace package
with no runtime dependencies: every document the readers send, validated in
its tests against a Hasura-shaped schema built from `schema.graphql`, and
typed results with BigInt columns as `bigint`.

```ts
import { createIndexerClient, toCents, toWebhookEvent, nextCursor } from "@polarispay/indexer-client";

const indexer = createIndexerClient({ url: process.env.POLARIS_INDEXER_URL! });

// Dashboard home
const { merchant, recentPayments, days } = await indexer.merchantOverview(wallet, { days: 30 });
const balanceCents = merchant ? toCents(merchant.balance) : 0;
const ledger = await indexer.plans(wallet, { filter: "dunning" });

// Checkout: "Paid" only from the index
const order = await indexer.waitForOrder(orderKey); // keccak256(encodePacked(merchant, orderId))

// Webhook dispatcher: tail the outbox, sign and send each event in order
// (Polaris for Business does this in apps/business/src/server/webhooks/outbox.ts)
let cursor = await loadCursor();
const { activities } = await indexer.activityAfter(cursor, 100);
for (const a of activities) {
  const merchant = await merchantByWallet(a.merchant_id);             // the API's record: its public mer_… id
  const session = a.orderKey ? await sessionByOrderKey(a.orderKey) : null; // the checkout session, if the order came through one
  const event = toWebhookEvent(a, { merchantId: merchant.publicId, session, automatic: await wasAutomaticPayout(a) });
  await deliver(event);                                                // serializeEvent, sign and send with @polaris/db
}
await saveCursor(nextCursor(cursor, activities));
```

`toWebhookEvent` builds exactly polarispay-sdk's `WebhookEvent<T>` (held to
the SDK's types and its `validateWebhookEvent` in the client's tests). The
client exports that check (`validateWebhookEvent`, a verbatim copy of the
SDK's `event-shape.ts` and `events.ts`, which `test/sdk-copy.test.ts` holds
byte for byte to the SDK's source), because the SDK ships only a build and
this package is TypeScript a Next.js app already transpiles. Events carry
amounts as USD decimal strings with 2 to 6 decimals (`"25.00"`,
`"201.534246"`), currency `"USD"`, mode `"now"` / `"later"`, EIP-55
addresses, ISO times, instalments numbered from 1, and `session.orderId`,
`sessionId` and `metadata` from the session you pass. Its `id` is the API's
own, `evt_` + the first 28 hex characters of
`sha256("<txHash>:<logIndex>:<type>")` (`webhookSourceKey`,
`webhookEventId`), so the API's dispatcher, which reads both its chain sync
and this outbox, stores and sends each chain event once, and a receiver
deduplicating on `id` sees it once either way. (Payouts are the exception:
the API keys a payout on its own payout record; its dispatcher uses that key
for a payout row it can match to its record, and skips the others.)

The CRE workflow cannot use `fetch`; it sends the same document through its
HTTP capability. `DUE_CANDIDATES` answers in the shape the
`polaris-collections` workflow already parses (`Loan[].loanId`,
`Subscription[].subId`), so pointing the workflow at the indexer is its
`candidates.indexerUrl` plus `candidates.indexerQuery` set to this document.
The pure helpers build the same task list anywhere else (anyone's keeper,
a script: every collection action is permissionless):

```ts
import { documents } from "@polarispay/indexer-client";
import { dueCandidatesRequest, parseDueCandidates, readyTasks, REPORT_ABI_PARAMETERS } from "@polarispay/indexer-client/cre";

documents.DUE_CANDIDATES;                                            // the workflow's candidates.indexerQuery
const req = dueCandidatesRequest(scheduledTimeSeconds, 50);          // same time on every node
const tasks = parseDueCandidates(json(httpResponse), scheduledTimeSeconds); // liquidations, collections, charges; sorted, deduplicated
const due = readyTasks(tasks, checkTasksResult);                     // CollectionsReceiver.checkTasks, one EVM read
// report body: encodeAbiParameters(parseAbiParameters(REPORT_ABI_PARAMETERS), [1, due])
```

Next.js apps add `transpilePackages: ["@polarispay/indexer-client"]` (the
package ships TypeScript source).

## Tests

| Suite | What it proves |
|---|---|
| `test/lib.test.ts` | The schedule mirror gives the contract's numbers ($200 x 4 weekly = 201534246 owed, 50383562 first instalment); the credit line mirrors `ScoreManager`; every revert selector recomputed with viem; `config.yaml` is current, indexes every event in every ABI, and every event it indexes has a handler; the client's SHA-256, Keccak-256 and checksums equal viem's |
| `test/paynow`, `plans`, `subscriptions`, `accounts` | Simulated flows through Envio's own test indexer: Pay now, Pay in 4 with dunning (a repeated skip is one miss), CRE collection, prepayment and liquidation, subscriptions with backoff, missed windows, lapses and cancellations, sends, payouts, batches, credit, CRE reports, roles; only registered merchants are followed |
| `test/live.test.ts` (`wsl.sh live`) | The same checks, but Envio's runtime fetches the chain itself over RPC: the config, the dynamic registration and the source-side filters are exercised too |
| `test/replay.test.ts` | A real chain: `scripts/record-fixture.mjs` runs the deploy script, the contracts' end-to-end flows and `scripts/fixture-scenarios.cjs` on a Hardhat node (port 3540) and records 170 logs of 65 kinds; replayed through the handlers, every plan, subscription, credit line, merchant balance and link equals what the contracts report, every webhook kind appears once per SDK event, every row passes polarispay-sdk's `validateWebhookEvent`, and totals equal a recount |
| `client/test` | Every document is valid against the schema; BigInt decoding is complete; the client's requests, errors and paging; CRE task building; every webhook kind equals polarispay-sdk's types (compile time) and passes its runtime check, with the API's amounts, addresses and event ids; the exported copy of that check is the SDK's source; SHA-256 and Keccak-256 against published vectors; money; the credit and loan mirrors equal the indexer's |

Re-record the fixture after a contract change (with the workspace
installed): `node packages/indexer/scripts/record-fixture.mjs`. It was
re-recorded on 6 Oct: the contracts had gained the CRE guardian and the
re-sign flow since the last recording, and three of their events
(`PolarisCheckout.Reauthorized` and `CreditGuardianSet`, the receivers'
`SimulationTransmitterSet`) were indexed with no handler, which Envio's
runtime passes over without a word. They are now `ConfigChange` rows. The
collection checks count from the fixture instead of fixed numbers, and the
recorder compiles before starting its node: a node started without artifacts
cannot name custom errors, and the contracts' end-to-end flows check reverts
by name.

## Layout

The indexer is its own pnpm project (`pnpm-workspace.yaml` excludes it) and
its client is a workspace package. The `envio` CLI needs its Linux binary,
which a Windows workspace install would skip, and Envio Cloud installs this
folder on its own. `scripts/wsl.sh` installs it with
`pnpm install --ignore-workspace` against its own `pnpm-lock.yaml`.

```
config.yaml            generated: contracts, every event signature, chain 10143
schema.graphql         entities
src/deployment.ts      generated: per-chain settings (grace, dunning ladder, addresses)
src/handlers/          one file per area; Envio loads them all
src/lib/               the mirrors (loans, credit, revert reasons) and the unit of work
scripts/generate.mjs   config + settings from the ABIs and a deployment record
scripts/wsl.sh         the one command
scripts/record-fixture.mjs, fixture-scenarios.cjs   the real-chain fixture
scripts/live.sh        the live end-to-end run (in-process, no database)
scripts/local.sh       GraphQL for a running local chain (Postgres + Hasura in Docker, envio start)
test/                  vitest + Envio's createTestIndexer
client/                @polarispay/indexer-client
```

## Not verified here

- **`envio dev` itself** was not run (on this machine it would collide with
  other projects' Envio containers); `pnpm indexer:local` runs the same
  Postgres and Hasura images under `envio start`, and every client document
  was checked against that live Hasura, `_meta` and numeric strings included.
  `_meta` on Envio Cloud is still unchecked (docs/research/envio.md
  section 11).
- **Nothing has indexed Monad testnet yet:** the deployment record exists
  and `config.yaml` is generated from it, but HyperSync needs an
  `ENVIO_API_TOKEN` we don't have, and there is no Envio Cloud deployment.
- The wildcard `Transfer` matches any token's transfers touching a merchant
  account; only the stablecoin's are used. An ERC-721 `Transfer` (same topic,
  three indexed arguments) to a merchant account would not decode as an
  ERC-20 one.

Written with Claude Code.

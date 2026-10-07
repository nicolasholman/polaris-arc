# polaris-indexer

The [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview) indexer
for Polaris on **Arc** (testnet 5042002, mainnet 5042). Envio lists Arc among
its supported indexers ([docs.arc.io](https://docs.arc.io/arc/tools/data-indexers)),
and `envio` **3.12.1** (pinned) serves both Arc chains from HyperSync
(`arc-testnet`, `arc`), with the public RPC configured as the fallback. A local
Hardhat chain is read over RPC.

It turns every event of every Polaris contract into the rows these read:

| Reader | What it asks |
|---|---|
| **Polaris for Business** ([`insights.ts`](../../apps/business/src/server/insights.ts)) | A merchant's events and the indexer's progress (`merchantActivity`, `status`); balances, payments, the Pay in 4 ledger, payouts, customers and daily charts are all queryable |
| **The webhook dispatcher** ([`outbox.ts`](../../apps/business/src/server/webhooks/outbox.ts)) | The `Activity` outbox after a cursor: polarispay-sdk's nine webhooks |
| **The Polaris keeper** (optional) | Which instalments are due (or due a retry on the dunning ladder), which plans are past grace, which subscriptions renew: `DueCandidates`. The keeper ([`services/keeper`](../../services/keeper)) scans the chain itself; this is a cheaper candidate list for it or any script |
| **The Polaris app** | The buyer's credit line and why, open plans, receipts, USDC and EURC send links |

The business app's built-in chain sync (viem log polling) is the default
path; set `POLARIS_INDEXER_URL` in `apps/business/.env` to add this indexer.

## Commands

The `envio` CLI runs on Linux and macOS (WSL from Windows). This package is
installed on its own (`pnpm-workspace.yaml` excludes it; Envio Cloud uploads
only this folder); its client is an ordinary workspace package.

```bash
bash packages/indexer/scripts/wsl.sh test    # install, generate --check, envio codegen, tsc, vitest (no Docker, no token)
bash packages/indexer/scripts/wsl.sh live    # a local chain indexed end to end by Envio's runtime over RPC (no Docker)
bash packages/indexer/scripts/wsl.sh local   # GraphQL for a running local chain (Postgres + Hasura in Docker, envio start)
pnpm --filter @polarispay/indexer-client test
```

`wsl.sh local` (also `pnpm indexer:local` at the root) expects a chain at
`POLARIS_LOCAL_RPC` (default `http://127.0.0.1:8600`) deployed with
`pnpm --filter @polarispay/contracts node:local` and `deploy:local`, and serves
GraphQL at `http://127.0.0.1:18080/v1/graphql`. Every variable is in
[`.env.example`](.env.example).

Against Arc testnet with hot reload (Docker): copy `.env.example` to `.env`,
add `ENVIO_API_TOKEN` (HyperSync), then `bash scripts/wsl.sh dev`.

## Configuration is generated

`config.yaml` and `src/deployment.ts` are generated from the contract ABIs
(`packages/contracts/abi`) and a deployment record, never edited:

```bash
pnpm --filter @polarispay/contracts deploy:testnet   # writes packages/contracts/deployments/arc-testnet.json
node packages/indexer/scripts/generate.mjs           # rewrites config.yaml and src/deployment.ts from it
node packages/indexer/scripts/generate.mjs --network mainnet   # from arc-mainnet.json
```

Commit both. Until `arc-testnet.json` exists every Polaris address is a marked
placeholder (`0x…cafe0001`…) and `src/deployment.ts` says `placeholder: true`;
USDC (`0x3600…0000`) and EURC are Circle's real addresses. Addresses come from
the record's `contracts.<Name>.address` and the start block is the first
Polaris deploy block (`contracts.<Name>.blockNumber`). `generate.mjs --check`
(run by the tests) fails when the files are stale.

`block_lag` defaults to 0: Arc's finality is deterministic and sub-second, so
an indexed block is final and a webhook never fires for a block that later
changes.

## What is indexed

Every event of `ScoreManager`, `PolarisLoanEngine`, `PolarisPayments`,
`MerchantRegistry`, `CollateralVault`, `BatchSettlement`, `PolarisSend`,
`PolarisSendEURC` (the same contract on EURC), `PolarisCheckout`,
`CollectionsReceiver`, `UnderwritingReceiver` and `CreditGuard`, plus USDC
`Transfer`s into and out of merchant accounts (`MerchantWallet`: an account is
followed from the block it registers with the `MerchantRegistry`, in
wildcard mode filtered at the source).

| Entity | Holds |
|---|---|
| `Merchant`, `Payment`, `Order`, `Customer` | Registration, totals by mode, the Pay in 4 book, MRR, USDC balance, payouts; every settled order; an order key from quoted to paid |
| `Plan`, `Installment`, `Repayment` | Pay in 4 schedules, what was paid toward each instalment and by whom (`BUYER`, `KEEPER` through the CollectionsReceiver, `OTHER`), dunning |
| `SubscriptionPlan`, `Subscription` | Plans, subscriptions, next charge, misses, backoff |
| `Send` | A link from open to claimed, cancelled or refunded; `currency` USD (PolarisSend) or EUR (PolarisSendEURC). Dollar and euro totals are kept apart (`sendVolume` vs `eurcSendVolume`) |
| `Payout`, `Batch`, `BatchLeg` | Merchant withdrawals (a USDC transfer out, sent to USDC itself); batch settlements with memos |
| `Buyer`, `ScoreEvent`, `Underwriting`, `LinkedWallet` | The credit line (mirrors `creditLimitOf`), every score move, the keeper's underwriting results |
| `KeeperReport`, `CollectionRun`, `CollectionTask` | Every report the Polaris keeper submitted (`submitReport`, one row per transaction), every collection task executed or skipped and why |
| `CreditGuard` | The credit guard's thresholds, owner override and acknowledged bad debt. Whether credit is paused is a live view (`CreditGuard.creditStatus()`), not indexed |
| `Activity` | The webhook outbox: one row per polarispay-sdk webhook, with a strictly increasing `cursor` |
| `MerchantDay`, `ProtocolDay`, `BuyerDay`, `Protocol`, `ConfigChange` | Daily totals and candles; protocol totals; every role and setting change (keeper key, operators, guard settings) |

Money is BigInt in base units (USDC and EURC both have 6 decimals); times
are Int unix seconds; addresses are lowercase. Envio Cloud has no aggregate
queries, so every total is a counter kept at indexing time.

Derivations worth knowing: schedules mirror the loan engine exactly
(`src/lib/loans.ts`), so `nextDueAt` and `liquidatableAt` need no `eth_call`;
a skipped collection is decoded (`src/lib/revert.ts`: allowance lost, short
on funds, or a stale candidate) and moves the plan along the 6 h / 24 h /
72 h / weekly dunning ladder, never past liquidation; webhooks are rows,
never side effects, because handlers run twice and can be rolled back.

## The client

[`client/`](client/) is `@polarispay/indexer-client`: every document the
readers send, validated against a Hasura-shaped schema built from
`schema.graphql`, typed results with BigInt columns as `bigint`, and
`toWebhookEvent` (an outbox row to exactly polarispay-sdk's `WebhookEvent`,
with the API's event id). `@polarispay/indexer-client/keeper` builds a
collections task list from `DueCandidates`. See its [README](client/README.md).

## Tests

| Suite | What it proves |
|---|---|
| `test/lib.test.ts` | The schedule and credit mirrors give the contracts' numbers; every revert selector recomputed with viem; `config.yaml` is current, indexes every event of every ABI, and every indexed event has a handler |
| `test/paynow`, `plans`, `subscriptions`, `accounts` | Simulated flows through Envio's own test indexer: Pay now, Pay in 4 with dunning, keeper collections and reports, subscriptions, USDC and EURC links, payouts, batches, credit, the credit guard, roles |
| `test/replay.test.ts` | A real chain: `scripts/record-fixture.mjs` runs `scripts/fixture-chain.cjs` on a Hardhat node (the Arc contract layer deployed with `packages/contracts/lib/deploy.js`, then every flow, the keeper's reports included) and records its logs; replayed through the handlers, every plan, subscription, credit line, merchant balance, link and the credit guard equal what the contracts report, and every outbox row passes polarispay-sdk's `validateWebhookEvent` |
| `test/live.test.ts` | The same checks with Envio's runtime fetching that chain over RPC (`wsl.sh live`) |

Re-record the fixture after a contract change:
`node packages/indexer/scripts/record-fixture.mjs` (needs the workspace
installed; it never writes to `packages/contracts/deployments`).

## Layout

```
config.yaml            generated: contracts, every event signature, the chain and its data source
schema.graphql         entities
src/deployment.ts      generated: per-chain settings (grace, dunning ladder, addresses)
src/handlers/          one file per area; Envio loads them all
src/lib/               the mirrors (loans, credit, revert reasons), keeper reports, the unit of work
scripts/generate.mjs   config + settings from the ABIs and a deployment record
scripts/wsl.sh         the one command (Linux, macOS, WSL, CI)
scripts/record-fixture.mjs, fixture-chain.cjs   the real-chain fixture
scripts/live.sh        the live end-to-end run (in-process, no database)
scripts/local.sh       GraphQL for a running local chain
test/                  vitest + Envio's createTestIndexer
client/                @polarispay/indexer-client
```

## Not verified here

- Nothing has indexed Arc testnet yet: Polaris is not deployed there
  (`config.yaml` holds placeholders), no `ENVIO_API_TOKEN` was used and there
  is no Envio Cloud deployment.
- `envio dev` itself was not run; `wsl.sh local` runs the same Postgres and
  Hasura images under `envio start`.
- The wildcard `Transfer` matches any token's transfers touching a merchant
  account; only USDC's are used.

# @polarispay/indexer-client

Typed GraphQL client for the Polaris Envio indexer on Arc: every document the
dashboard, the webhook dispatcher, the Polaris keeper and the Polaris app send,
with results typed and BigInt columns decoded to `bigint` (USDC and EURC base
units, 6 decimals). No runtime dependencies.

```bash
pnpm --filter @polarispay/indexer-client test        # documents vs the schema, client, keeper tasks, webhooks
pnpm --filter @polarispay/indexer-client typecheck
```

```ts
import { createIndexerClient } from "@polarispay/indexer-client";
const indexer = createIndexerClient({ url: process.env.POLARIS_INDEXER_URL!, chainId: 5042002 }); // Arc testnet is the default
const { merchant, days } = await indexer.merchantOverview(wallet);
```

- `@polarispay/indexer-client`: `createIndexerClient` (dashboard, checkout,
  webhooks, app, the keeper's `collector()` card with its reports and the
  credit guard's settings); `toWebhookEvent` (an outbox row to exactly
  polarispay-sdk's `WebhookEvent`, with the API's event id) / `nextCursor` /
  `validateWebhookEvent`; `toCents` / `formatUsd` / `formatAmount`;
  `creditLimitOf`; the row types.
- `@polarispay/indexer-client/keeper`: pure helpers that turn the indexer's
  `DueCandidates` answer into a collections task list for
  `CollectionsReceiver.checkTasks` and `submitReport`
  (`dueCandidatesRequest`, `parseDueCandidates`, `readyTasks`).
- `@polarispay/indexer-client/documents`: the raw GraphQL documents.

`src/sdk-events.ts` and `src/sdk-event-shape.ts` are verbatim copies of
polarispay-sdk's source (`test/sdk-copy.test.ts` holds them byte for byte).
The indexer, its schema and how to run and deploy it are in
[`../README.md`](../README.md). The package ships TypeScript source: Next.js
apps add it to `transpilePackages`.

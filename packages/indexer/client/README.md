# @polarispay/indexer-client

Typed GraphQL client for the Polaris Envio indexer: every document the
dashboard, the webhook dispatcher, the CRE collections workflow and the
Polaris app send, with results typed and BigInt columns decoded to `bigint`.
No runtime dependencies.

```bash
pnpm --filter @polarispay/indexer-client test        # documents vs the schema, client, CRE, webhooks
pnpm --filter @polarispay/indexer-client typecheck
```

```ts
import { createIndexerClient } from "@polarispay/indexer-client";
const indexer = createIndexerClient({ url: process.env.POLARIS_INDEXER_URL! });
const { merchant, days } = await indexer.merchantOverview(wallet);
```

- `@polarispay/indexer-client`: `createIndexerClient` (dashboard, checkout,
  webhooks, app); `toWebhookEvent` (an outbox row to exactly polarispay-sdk's
  `WebhookEvent`, with the API's event id) / `nextCursor`; `toCents` /
  `formatUsd` / `formatAmount`; `creditLimitOf`; the row types.
- `@polarispay/indexer-client/cre`: pure helpers for the CRE workflow
  (`dueCandidatesRequest`, `parseDueCandidates`, `readyTasks`).
- `@polarispay/indexer-client/documents`: the raw GraphQL documents.

The indexer, its schema and how to run and deploy it are in
[`../README.md`](../README.md). The package ships TypeScript source: Next.js
apps add it to `transpilePackages`.

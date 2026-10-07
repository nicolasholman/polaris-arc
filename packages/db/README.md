# @polaris/db

Storage and crypto primitives for Polaris for Business (`apps/business`):

| Module | What it is |
|---|---|
| `@polaris/db/store` | A small document store: `openStore("sqlite:<path>")` on Node's built-in `node:sqlite` (Node 22.13+, nothing to install or compile), or `openStore("memory:")`. Collections declare the fields they are queried by; each becomes an indexed column. `update` is an atomic read-modify-write. |
| `@polaris/db/schema` | Every record the backend keeps (merchants, API keys, checkout sessions, idempotency keys, relays, payments, plans, subscriptions, payouts, payment links, webhook endpoints, events and deliveries (each with its source: the chain sync, the Envio indexer's outbox, or a test), the chain cursor, the indexer outbox's cursor) and the collection specs over them. |
| `@polaris/db/keys` | CSPRNG ids and keys (`sk_test_…`, `pk_test_…`, `whsec_…`), HMAC-SHA256 key hashing under a server pepper, canonical JSON for request fingerprints. |
| `@polaris/db/webhooks` | Stripe-shaped webhook signing (`Polaris-Signature: t=…,v1=…` over `${t}.${rawBody}`, exactly what `polarispay-sdk` verifies), the event envelope, the retry schedule (8 attempts over ~34 h), and one delivery attempt with an SSRF guard that refuses private addresses at connect time (DNS rebinding included). |

It ships TypeScript sources (erasable syntax only), so Next.js transpiles it
(`transpilePackages`) and the business app's scripts load it directly with
Node's type stripping.

```bash
pnpm install
pnpm --filter @polaris/db test        # store (memory and SQLite), signatures, retries, SSRF guard, keys
pnpm --filter @polaris/db typecheck
```

## The store in one screen

```ts
import { collections, openStore } from "@polaris/db";

const db = collections(openStore("sqlite:.data/polaris.db"));
await db.sessions.insert(session);                                  // DuplicateKeyError if the id exists
await db.sessions.update(id, (s) => ({ ...s, status: "complete" })); // atomic
await db.webhookDeliveries.find({ state: "pending", nextAttemptAtMs: { lte: Date.now() } }, { orderBy: "nextAttemptAtMs", limit: 25 });
```

- Queries are equality, `ne`, ranges (`lt`, `lte`, `gt`, `gte`) and `in` on
  declared index fields, with SQL's NULL rules in both implementations.
- A collection that gains an index later gets the column added and
  back-filled the first time it is opened.
- SQLite runs in WAL mode with a 5 s busy timeout, so the dev server and a
  script (e.g. `apps/business/scripts/dev-merchant.mjs`) can share a file.

**Deployment:** one server with a persistent disk (a VM, Fly, Railway, a
container with a volume). A serverless host needs a network database: implement
`Store` over Postgres; nothing above this package changes.

## Webhook deliveries

```ts
import { deliverWebhook, serializeEvent, nextAttemptAt } from "@polaris/db";

const body = serializeEvent({ id, object: "event", type: "payment.succeeded", createdAt, livemode: false, merchantId, data });
const outcome = await deliverWebhook({ url, secret, eventType: "payment.succeeded", body, attempt: 1 });
// outcome: { ok, status, durationMs, error, responseBody, retryable, request: { headers, body } }
if (!outcome.ok && outcome.retryable) scheduleAt(nextAttemptAt(1, Date.now()));
```

Every attempt of an event sends the same bytes under a fresh timestamp.
Endpoints must be `https://` and publicly routable; `allowPrivate` exists for
local development only (the business app never sets it in production).

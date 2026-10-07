# Halcyon: a store that takes payment through Polaris

Halcyon is a demo online store (headphones, lamps, a chair, a coffee
subscription) built the way any merchant would integrate Polaris. It exists
for the Monad Metropolis demo: a normal-looking shop, with Polaris only where
a store embeds a payment provider.

- **Product pages** carry Polaris on-site messaging under the price: *or 4
  payments of $87.92 with Polaris*, with a *Learn more* popover. Pay in 4 is
  quoted at the loan engine's 10% APR, with nothing to pay at checkout and
  the first payment a week later.
- **The bag** (a drawer and `/cart`) repeats it for the bag total.
- **Checkout** offers two ways to pay:
  - **Polaris**: *Pay in full*, *Pay in 4* on Polaris credit, or *Subscribe*
    for the Coffee Club. The server creates a checkout session with the SDK;
    the browser opens the hosted Polaris checkout in a centred popup (a
    full-page redirect on phones) and reacts to the result it posts back.
  - **Pay directly with a wallet**: `polaris.pay()` asks any EIP-1193 wallet
    (`window.ethereum`) for one ERC-3009 signature and the Polaris relayer
    submits it gas-free, with every state shown: connect (and switch to
    Monad Testnet), sign, relaying, paid, declined, wrong network, no wallet.
- **The receipt** (`/orders/[id]`) updates live. An order becomes *paid* only
  when a signed Polaris webhook says so, never because the browser did. Pay in
  4 orders show the four-payment schedule from `plan.opened` and tick off each
  `installment.collected`; subscriptions show the next charge date.
- **Built with Polaris** (the floating button, bottom left) shows the exact SDK
  calls this checkout made, server and browser, and every webhook it received,
  with the ten lines of integration code.

Pages: `/`, `/shop`, `/products/[slug]`, `/cart`, `/checkout`,
`/orders/[id]`. Screenshots of each page and each checkout path, at 1440×900
and 390×844, are in [`docs/design/shop`](../../docs/design/shop): `desktop-*`
and `mobile-*`, plus `popup-*` for the Polaris window on desktop (440×700,
the inside of the window the SDK opens). Each numbered path runs from the
checkout to the receipt: Pay now (12), Pay in 4 with the developer drawer
and a collected instalment (13), Subscribe (14), canceling (15), the window
closed without paying (22), a wallet payment (16), the wrong network (17)
and a declined signature (18). Also shown: invalid details (19), the 404
(20), the phone menu (21), the phone buy bar (03b) and keyboard focus on
the payment choice (23). They were taken against a development mock of the
Polaris API that the shop carried at the time and has since removed (the
Polaris window in them is that mock's test checkout, not the Polaris app),
with motion settled; the wallet screens use a scripted EIP-1193 test wallet
in place of MetaMask.

## The integration

The shop uses **`polarispay-sdk` 0.3.0** from this workspace
(`packages/sdk`, merged from the `metropolis/sdk` branch). Every Polaris call
is in two files:

| File | Side | Calls |
|---|---|---|
| [`src/lib/polaris.ts`](src/lib/polaris.ts) | Server, `polarispay-sdk/server` | `createPolarisServer`, `checkout.sessions.create` (the order's `payRef` as `orderId`, one idempotency key per order and attempt), `checkout.sessions.retrieve`, `webhooks.verify`, `credit.guard` |
| [`src/lib/polaris-client.ts`](src/lib/polaris-client.ts) | Browser, `polarispay-sdk` and `polarispay-sdk/react` | `createPolaris`, `openCheckout` (through `PolarisCheckoutButton`), `pay`, `PolarisMessaging`, `PolarisMark` |

The SDK ships from `dist/`, so it has to be built before the shop runs:
`pnpm --filter @polaris/shop dev`, `build` and `test` do it first (so does the
`shop` entry in `.claude/launch.json`, which runs the dev script on port 3600).

The routes that use them:

| Route | What it does |
|---|---|
| `POST /api/checkout` | Validates and prices the order from the catalogue (never from the browser), stores it as `awaiting_payment` under the request's `Idempotency-Key`, sets the order's access cookie, then either creates a Polaris checkout session or returns what `pay()` needs. With `continueOrder`, an unpaid order for the same goods is reused when the buyer changes how they pay |
| `POST /api/webhooks/polaris` | Verifies the signature against the raw body, dedupes on the event id, and moves the order forward if the event matches it (amount, currency). The only writer of `paid` |
| `GET /api/orders/[id]` | The order, for the receipt to poll: whole for the browser that placed it, with the buyer's name, email and address masked for anyone else. `?sync=1` also shows the session status from `sessions.retrieve`, for the placing browser only, while the order is unpaid, at most once every 10 seconds |
| `POST /api/orders/[id]/log` | The browser reports its SDK calls for the developer drawer: only the placing browser, only while the order is unpaid, up to 12 entries. It can only append to a log |

**Who can read an order.** The order id is in the receipt's URL, so it isn't
a secret. `/api/checkout` sets an HttpOnly, `SameSite=Lax` cookie holding a
random token for the order; with it the receipt and the drawer get the whole
order, and without it (a forwarded link, a guessed id) the buyer's details
are masked. Polaris and the chain never see the order id at all: sessions
and direct payments carry the order's `payRef` (`hcp_…`), which is what
`PaymentMade` writes on chain and what webhooks name the order by.

**Pay in 4 while Polaris's risk guard has paused it.** Each page reads
`polaris.credit.guard()` (at most every 10 s, never holding a page up past
2.5 s, and read as open when the API doesn't answer). While the guard (a
Chainlink CRE workflow watching the credit pool and the AUSD/USD price) has
paused new plans, the product line and the bag show *Polaris Pay in 4 is paused
by our risk guard; pay now works as usual.* (`<PolarisMessaging paused>`), the
phone buy bar and the home band drop the offer, and the checkout opens on Pay
now with Pay in 4 marked *Paused* and the same sentence. The hosted checkout
and the chain apply the guard whatever the page said.

An order becomes paid on `payment.succeeded` (Pay now, and direct wallet
payments), `plan.opened` (Pay in 4: the store is paid the principal in full
when the plan opens) or the first `subscription.charged`, and only when the
amount and currency match the order; anything else sends it to review.

Orders live in `apps/shop/.data/orders.json` (git-ignored), with an in-memory
fallback when the disk isn't writable.

## Without Polaris configured

The shop pays only through Polaris for Business; there is no stand-in for
it. With `POLARIS_API_BASE` or any key below unset, nothing pretends to work:

- the checkout says *Payments aren't configured* and offers no pay button
  (in `next dev` it also names the missing settings);
- `POST /api/checkout` answers `503 payments_not_configured`, places no
  order and calls nothing;
- `GET /api/health` reports `polaris: { configured: false, reason }`;
- the webhook endpoint answers 503.

The catalogue, the bag and the pages still render, so the store can be
browsed without a backend.

## Demo recording

Record against the real hosted checkout, so the Polaris window on camera is
the Polaris app:

1. `pnpm demo:local` at the repo root (a local chain, the API on :3100, the
   Polaris app on :3000 and this store on :3600, with fresh keys), or run
   them by hand as below.
2. A fresh browser profile, 1440×900, at http://127.0.0.1:3600.
3. Home → Halcyon One → Add to bag → Check out → Pay in 4 → *Pay in 4 ·
   $87.92 a week* → Face ID in Polaris → the receipt (0 of 4 paid, next in
   a week) → *Built with Polaris* for the code and the webhooks.

## Run it against the real Polaris backend

1. Start the Polaris API (apps/business, port 3100) and the hosted checkout
   (apps/app, port 3000).
2. In Polaris for Business, create test API keys and a webhook endpoint for
   `http://localhost:3600/api/webhooks/polaris`.
3. Copy [`.env.example`](.env.example) to `.env.local` (git-ignored) and set:

   ```bash
   POLARIS_API_BASE=http://localhost:3100
   POLARIS_SECRET_KEY=sk_test_…
   NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY=pk_test_…
   NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN=http://localhost:3000
   POLARIS_WEBHOOK_SECRET=whsec_…
   POLARIS_MERCHANT_ADDRESS=0x…          # the store's payout address
   # POLARIS_RELAY_URL=…                 # defaults to {POLARIS_API_BASE}/api/v1/relay/payments
   ```

4. `pnpm --filter @polaris/shop dev` (http://127.0.0.1:3600).

In production (`next build && next start`) all six values are required, plus
`SHOP_URL` (the store's public URL, which success and cancel URLs are built
from instead of the request's `Host`); with any missing, checkout shows
*Payments aren't configured* instead of guessing. Behind a proxy that sets
`X-Forwarded-Host`, set `TRUST_PROXY=1`; otherwise those headers are ignored.

**Hosted** (Vercel, [`docs/deploy.md`](../../docs/deploy.md) step 4): orders
live in Upstash Redis (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, which the
project's Storage tab adds), because each Vercel function has its own memory
and a read-only disk, and a webhook landing in another function would never
find the order (`src/lib/orders/redis-store.ts`: one record per deployment
environment, updated under a lock). On a long-lived server the JSON file in
`SHOP_DATA_DIR` is enough. `GET /api/health` reports how the store is wired
(the API, checkout and relay it uses, where orders are kept; never a secret),
and `scripts/deploy-check.mjs` checks it.

The store quotes Pay in 4 at `PolarisLoanEngine.INTEREST_RATE_BPS`, 10% APR,
the only rate the loan engine charges, so the badge, checkout and receipt
quote exactly what the buyer pays: $349 is 4 × $87.92 ($2.68 of interest,
$351.68 in total), and $200 is 4 × $50.38. Nothing is paid at checkout; the
first instalment falls due a week later, as `installmentDueAt` dates it.
There is no interest-free plan; `POLARIS_PAY_IN_4_APR_BPS` set to anything
else is ignored with a warning.

## Checks

```bash
pnpm --filter @polaris/shop test        # builds the SDK, then vitest
pnpm --filter @polaris/shop lint
pnpm --filter @polaris/shop typecheck
pnpm --filter @polaris/shop build       # ends with scripts/assert-api-routes.mjs
```

The tests cover the session route (catalogue pricing, the exact request the
SDK sends, idempotency, retries, validation, the subscription rules,
payments not configured in any environment), the Polaris settings (every
key required, no fallback, no secret in the browser), webhook verification
through the store's
config (valid, tampered, wrong secret, stale, future, re-stamped, malformed,
rolled secrets), the webhook route (tampered, unsigned, stale and replayed
deliveries, out-of-order instalments, no client write path), the order status
transitions for every event, Pay in 4 pricing, the health report, and the
store's API: `src/app/api` serves exactly the routes in
[`scripts/api-routes.json`](scripts/api-routes.json). The build holds the
compiled routes to the same list (`scripts/assert-api-routes.mjs`), so a
stand-in for Polaris or a test hook can't ship. Polaris itself is replaced
by a stubbed `fetch` inside the tests only.

## What the shop needs from the SDK

Found while building against `polarispay-sdk` 0.3.0. The shop now carries
the `metropolis/sdk` fixes for the old items 3 and 5 (merged): `pay()`
returns a `wrong_chain` error when the buyer declines the network switch,
which the shop turns into a *Switch to Monad Testnet* step, and
`quotePayIn4`'s rows add up to its total and are dated from one interval
after checkout, as `PolarisLoanEngine` dates them. What's still open:

1. **`pay()` can't run until PolarisPayments is deployed**, and there's no
   test path: it reads decimals, the EIP-712 domain, the balance,
   `paymentFor` and `quotedAmount` through the wallet. A test mode (or
   overrides for those reads) would let a store demo direct pay against a
   test relayer before the contracts land.
2. **`PolarisPayButton` needs an async order.** Its `orderId` is a string or
   a synchronous function, but a store has to create the order on its server
   (the id the buyer signs for must exist and be unguessable) at click time.
   The shop calls `polaris.pay()` from its own button instead; a
   `createOrder: () => Promise<{ orderId, merchant, amount }>` prop would fix it.
3. **A result code, not only a cause.** `wrong_chain` and `no_wallet` are on
   `result.cause.code`; a `code` on the result itself would be easier to
   branch on. The SDK's buyer text also spells it "cancelled" where the
   store says "canceled", so the shop rewrites that one message.
4. **Messaging figures.** `.plrs-msg strong` and `.plrs-caption strong` force
   `tabular-nums`, which in some fonts (Schibsted Grotesk here) spaces out
   the point: "$87 . 25". The store overrides it; the SDK could leave figures
   to the host font or expose `--polaris-numeric`.
5. **The Learn more link's spacing.** `.plrs-link` has a left margin, so a
   wrapped link starts indented; the store moves the gap onto `.plrs-brand`.
   A mobile scrim for the popover would save stores the same override.
6. **Line items can't carry a variant or a photo.** `LineItem` is name,
   quantity and price, so the shop folds the option into the name ("Halcyon
   One, Graphite"). `description` and `imageUrl` would let the hosted checkout
   show what the buyer is paying for.
7. **A Polaris lockup component.** The SDK exports the mark; stores that list
   Polaris among payment methods need mark + wordmark (the shop sets its own).
8. **Pay in 4 terms from the API.** The store quotes the loan engine's 10%
   APR (`POLARIS_PAY_IN_4_APR_BPS`, default 1000), which matches the
   contracts and the hosted checkout. The merchant's terms from the API (or
   the session) would keep the badge, the button and the hosted checkout in
   agreement without a store setting.
9. **A subscription messaging variant** would let the Coffee Club page say
   *Subscribe with Polaris* in the provider's own words.
10. **Workspace consumers need a build step.** The package exports only
    `dist/`; a `development` export condition pointing at `src/` would let
    apps in the monorepo use it without building it first.

## Credits

The product photographs and the room scene in `public/products` are
AI-generated for this demo and show no real brands. Type: Hedvig Letters Serif
and Schibsted Grotesk (SIL Open Font License), JetBrains Mono (OFL), self-hosted
through Fontsource. Motion by [Motion](https://motion.dev).

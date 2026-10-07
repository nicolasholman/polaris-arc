# Halcyon: a store that takes payment through Polaris on Arc

Halcyon is a demo online store (headphones, lamps, a chair, a coffee
subscription) built the way any merchant would integrate Polaris: a
normal-looking shop, with Polaris only where a store embeds a payment
provider. Every payment settles in USDC on Arc testnet and is final in under a
second; gas on Arc is paid in USDC, and Polaris pays it, so buyers hold dollars
and nothing else.

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
    (`window.ethereum`) for one ERC-3009 signature over USDC, and the Polaris
    relayer submits it and pays the gas, with every state shown: connect (and
    switch to Arc Testnet), sign, relaying, paid, declined, wrong network, no
    wallet.
- **The receipt** (`/orders/[id]`) updates live, with the transaction on the
  Arc explorer. An order becomes *paid* only when a signed Polaris webhook says
  so, never because the browser did. Pay in 4 orders show the four-payment
  schedule from `plan.opened` and tick off each `installment.collected`
  (collected by the Polaris keeper); subscriptions show the next charge date.
- **Built with Polaris** (the floating button, bottom left) shows the exact SDK
  calls this checkout made, server and browser, and every webhook it received,
  with the ten lines of integration code.

Pages: `/`, `/shop`, `/products/[slug]`, `/cart`, `/checkout`, `/orders/[id]`.

## The integration

The shop uses **`polarispay-sdk`** from this workspace (`packages/sdk`), whose
`ARC_TESTNET` preset is the chain direct wallet payments sign for. Every
Polaris call is in two files:

| File | Side | Calls |
|---|---|---|
| [`src/lib/polaris.ts`](src/lib/polaris.ts) | Server, `polarispay-sdk/server` | `createPolarisServer`, `checkout.sessions.create` (the order's `payRef` as `orderId`, one idempotency key per order and attempt), `checkout.sessions.retrieve`, `webhooks.verify`, `credit.guard` |
| [`src/lib/polaris-client.ts`](src/lib/polaris-client.ts) | Browser, `polarispay-sdk` and `polarispay-sdk/react` | `createPolaris`, `openCheckout` (through `PolarisCheckoutButton`), `pay`, `PolarisMessaging`, `PolarisMark` |

The SDK ships from `dist/`, so it has to be built before the shop runs:
`pnpm --filter @polaris/shop dev`, `build`, `lint`, `typecheck` and `test` do it
first.

| Route | What it does |
|---|---|
| `POST /api/checkout` | Validates and prices the order from the catalogue (never from the browser), stores it as `awaiting_payment` under the request's `Idempotency-Key`, sets the order's access cookie, then either creates a Polaris checkout session or returns what `pay()` needs. With `continueOrder`, an unpaid order for the same goods is reused when the buyer changes how they pay |
| `POST /api/webhooks/polaris` | Verifies the signature against the raw body, dedupes on the event id, and moves the order forward if the event matches it (amount, currency). The only writer of `paid` |
| `GET /api/orders/[id]` | The order, for the receipt to poll: whole for the browser that placed it, with the buyer's details masked for anyone else. `?sync=1` also reads the session status, for the placing browser only, while unpaid, at most every 10 seconds |
| `POST /api/orders/[id]/log` | The browser reports its SDK calls for the developer drawer: only the placing browser, only while unpaid, up to 12 entries, append-only |
| `GET /api/health` | How the store is wired (API, checkout, relay, order store), never a secret |

**Who can read an order.** The order id is in the receipt's URL, so it isn't a
secret. `/api/checkout` sets an HttpOnly, `SameSite=Lax` cookie holding a
random token for the order; without it the buyer's details are masked.
Polaris and the chain never see the order id: sessions and direct payments
carry the order's `payRef` (`hcp_…`), which is what `PaymentMade` writes on
chain and what webhooks name the order by.

**Pay in 4 while the credit guard has paused it.** Each page reads
`polaris.credit.guard()` (at most every 10 s, never holding a page up past
2.5 s, and read as open when the API doesn't answer). The credit guard is an
on-chain contract that reads the credit pool live; while it has paused new
plans, the product line and the bag show *Polaris Pay in 4 is paused by our
risk guard; pay now works as usual.*, the phone buy bar and the home band drop
the offer, and the checkout opens on Pay now with Pay in 4 marked *Paused*. The
hosted checkout and the chain apply the guard whatever the page said.

An order becomes paid on `payment.succeeded` (Pay now, and direct wallet
payments), `plan.opened` (Pay in 4: the store is paid the principal in full
when the plan opens) or the first `subscription.charged`, and only when the
amount (USDC's six decimals, read exactly) and currency match the order;
anything else sends it to review.

## Configuration

Every variable is documented in [`.env.example`](.env.example). The store
pays only through Polaris for Business; with `POLARIS_API_BASE` or any key
unset, nothing pretends to work: the checkout says *Payments aren't
configured* (in `next dev` it names the missing settings), `POST /api/checkout`
answers `503 payments_not_configured`, `GET /api/health` reports
`polaris: { configured: false, reason }`, and the webhook endpoint answers 503.
The catalogue, the bag and the pages still render.

To run it against a real backend:

1. `pnpm demo:local` at the repo root (a local chain, the API on :3100, the
   Polaris app on :3000 and this store on :3600, with fresh keys), or by hand:
   start Polaris for Business (apps/business, :3100) and the Polaris app
   (apps/app, :3000), create test API keys and a webhook endpoint for
   `http://localhost:3600/api/webhooks/polaris`, and copy `.env.example` to
   `.env.local`:

   ```bash
   POLARIS_API_BASE=http://localhost:3100
   POLARIS_SECRET_KEY=sk_test_…
   NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY=pk_test_…
   NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN=http://localhost:3000
   POLARIS_WEBHOOK_SECRET=whsec_…
   POLARIS_MERCHANT_ADDRESS=0x…          # the store's payout address on Arc
   # POLARIS_RELAY_URL=…                 # defaults to {POLARIS_API_BASE}/api/v1/relay/payments
   ```

2. `pnpm --filter @polaris/shop dev` (http://127.0.0.1:3600).

Test USDC for a wallet on Arc testnet comes from Circle's faucet. In production
(`next build && next start`) all six values are required, plus `SHOP_URL`.
Hosted on Vercel, orders live in Upstash Redis (`KV_REST_API_URL`,
`KV_REST_API_TOKEN`) because each function has its own memory and a read-only
disk; on a long-lived server the JSON file in `SHOP_DATA_DIR` is enough.

Pay in 4 is quoted at `PolarisLoanEngine.INTEREST_RATE_BPS`, 10% APR, the
only rate the loan engine charges: $349 is 4 × $87.92 ($351.68 in total), and
$200 is 4 × $50.38. Nothing is paid at checkout; the first instalment falls
due a week later.

## Checks

```bash
pnpm --filter @polaris/shop test        # builds the SDK, then vitest
pnpm --filter @polaris/shop lint
pnpm --filter @polaris/shop typecheck
pnpm --filter @polaris/shop build       # ends with scripts/assert-api-routes.mjs
```

The tests cover the session route (catalogue pricing, the exact request the
SDK sends, idempotency, retries, validation, subscriptions, payments not
configured), the Polaris settings, webhook verification (valid, tampered,
wrong secret, stale, future, malformed, rolled secrets), the webhook route
(replays, out-of-order instalments, no client write path), the order status
transitions for every event, Pay in 4 pricing, the credit guard, the health
report, and the store's API surface: `src/app/api` serves exactly the routes in
[`scripts/api-routes.json`](scripts/api-routes.json), and the build holds the
compiled routes to the same list, so a stand-in for Polaris or a test hook
can't ship. Polaris itself is replaced by a stubbed `fetch` inside the tests
only.

## Credits

The product photographs and the room scene in `public/products` are
AI-generated for this demo and show no real brands. Type: Hedvig Letters Serif
and Schibsted Grotesk (SIL Open Font License), JetBrains Mono (OFL), self-hosted
through Fontsource. Motion by [Motion](https://motion.dev).

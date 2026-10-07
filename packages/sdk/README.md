# polarispay-sdk

Stripe's ergonomics for any app on Monad. Create a checkout session on your
server, send the buyer to Polaris, and get a signed webhook when the money
lands. The buyer picks **Pay now**, **Pay in 4** on their Polaris credit line,
or **Subscribe**. You're paid in full, in AUSD, in under a second.

| Entry point | Runs in | What's in it |
|---|---|---|
| `polarispay-sdk/server` | your server (Node, edge, Bun, Deno) | `createPolarisServer`: checkout sessions, webhook verification |
| `polarispay-sdk` | the browser | `createPolaris`: open the hosted checkout, direct wallet pay, Pay in 4 quotes, Monad presets |
| `polarispay-sdk/react` | React 18 or 19 | `PolarisCheckoutButton`, `PolarisMessaging`, `PolarisPayButton`, `usePolarisCheckout` |

```bash
npm install polarispay-sdk ethers
```

`ethers` is loaded only when a wallet method runs, so a page that just opens the
hosted checkout stays small. React is optional.

---

## The ten-line integration

**Server** (a Next.js route; any framework works the same way):

```ts
// app/api/checkout/route.ts
import { createPolarisServer } from "polarispay-sdk/server";

const polaris = createPolarisServer({ secretKey: process.env.POLARIS_SECRET_KEY!, baseUrl: process.env.POLARIS_BASE_URL! });

export async function POST(req: Request) {
  const order = await req.json();
  const session = await polaris.checkout.sessions.create(
    { amount: order.total, description: order.title, modes: ["now", "later"], successUrl: "https://your.shop/thanks", orderId: order.id },
    { idempotencyKey: order.id },
  );
  return Response.json(session);
}
```

**Browser**:

```tsx
import { PolarisCheckoutButton } from "polarispay-sdk/react";

<PolarisCheckoutButton
  publishableKey="pk_test_…"
  amount={cart.total}
  createSession={() => fetch("/api/checkout", { method: "POST", body: JSON.stringify(cart) }).then((r) => r.json())}
  onSuccess={() => router.push("/thanks")}
/>;
```

The button opens the checkout in a centred popup on desktop and full-screen on
phones, shows *"or 4 × $50.38 with Pay in 4"* under itself, and tells you how it
ended. Then **fulfil from the webhook** (below), never from the browser.

No React? `redirect(session.url)` from the server route is a complete
integration too.

---

## Server: `createPolarisServer`

```ts
import { createPolarisServer } from "polarispay-sdk/server";

const polaris = createPolarisServer({
  secretKey: "sk_test_…",           // Developers → API keys in Polaris for Business
  baseUrl: "http://localhost:3100", // your Polaris for Business deployment
  // fetch, timeoutMs (30 000), maxRetries (2), webhookToleranceSeconds (300)
});
```

It refuses a publishable key, refuses plain `http` except on localhost (the
secret key travels in every request), and refuses to run in a browser.

### `checkout.sessions.create(params, { idempotencyKey })`

| Param | Type | |
|---|---|---|
| `amount` | `"200.00"` | Total in USD. Optional with `lineItems` (their sum); if both are given they must agree. |
| `currency` | `"USD"` | The only currency: every payment settles in AUSD. |
| `description` | string | One line under your name on the checkout. Required, ≤ 500 chars. |
| `lineItems` | `{ name, quantity?, unitAmount }[]` | Shown on the checkout and the receipt. |
| `modes` | `("now" \| "later" \| "subscribe")[]` | What the buyer may choose. Default `["now", "later"]`. |
| `subscription` | `{ interval: "day"\|"week"\|"month"\|"year", intervalCount? }` | With `"subscribe"`; `amount` is then the price per period. Default monthly. |
| `successUrl` | https URL | Where the buyer lands after paying. `{CHECKOUT_SESSION_ID}` is replaced. |
| `cancelUrl` | https URL | Where *Cancel* goes. |
| `orderId` | string | Your reference, echoed as `data.orderId` on this session's webhooks. |
| `metadata` | `Record<string, string>` | ≤ 20 keys (40 chars) of ≤ 500-char values, echoed on the session and webhooks. |

Returns the session: `{ id, url, status, expiresAt, … }` (full shape under
[HTTP API](#http-api)). Parameters are validated before anything is sent, so a
typo fails in your tests with the field named.

**Idempotency.** Pass your order id as `idempotencyKey`: a retried request
returns the first session instead of creating a second. Without one, the SDK
generates a key per call so its own retries (network errors, 429, 5xx, with
backoff and `Retry-After`) are still safe.

### `checkout.sessions.retrieve(id)`

The session's current state, including `payment` once it's paid. Use it on your
success page to show "Paid" without waiting for the webhook.

### `credit.guard()`

Whether a buyer can start a new Pay in 4 plan right now. Polaris's risk guard
(a Chainlink CRE workflow that watches the credit pool and the AUSD/USD price)
pauses new plans on chain when either is unhealthy; Pay now and Subscribe keep
working, and plans already open keep collecting.

```ts
const guard = await polaris.credit.guard();
// { state: "paused", paused: true, reasons: ["depeg"], message: "Pay in 4 is paused by our risk guard; pay now works as usual.", checkedAt, ageSeconds, readAt }
```

While `paused`, show Pay in 4 as unavailable with `message` (and pass it to
`<PolarisMessaging paused>`); the hosted checkout does the same. `state` is
`stale` or `never` when the guard is late: it then blocks nothing.

### `splits.retrieve(id)`

A split-the-bill link's status, by its id (the `0x…` in `/split/0x…`): each
share's amount and whether (and when) it was paid, and whether the split is
`open`, `settled`, `closed` or `expired`. It comes from PolarisSplit on
chain. The split's words (what it's for, the names) are the organiser's and
travel only in the link, so they are not here; `memoHash` is their hash.

```ts
const split = await polaris.splits.retrieve("0x5f1e…1100");
// { status: "open", totalUnits: "90000000", paidCount: 1, shareCount: 3, shares: [{ index: 0, amountUnits: "30000000", paid: true, paidAt, txHash }, …], … }
```

### Errors

Everything throws `PolarisError` with `type`, `code`, `status`, `param` and
`requestId`:

| `type` | When |
|---|---|
| `invalid_request_error` | Bad parameters (caught locally, or a 4xx) |
| `authentication_error` | 401: the key is wrong or rolled |
| `permission_error` | 403 |
| `idempotency_error` | 409: the same key with different parameters |
| `rate_limit_error` | 429 after every retry |
| `api_error` | 5xx after every retry |
| `connection_error` | Unreachable, or no answer within `timeoutMs` |
| `configuration_error` | A missing key or baseUrl, the server SDK in a browser, an undeployed contract |

---

## Webhooks

Polaris signs every delivery. Verify it with the **raw** body: re-serialised
JSON isn't the bytes that were signed.

```ts
// app/api/polaris/webhook/route.ts
import { createPolarisServer, PolarisSignatureVerificationError } from "polarispay-sdk/server";

const polaris = createPolarisServer({ secretKey: process.env.POLARIS_SECRET_KEY!, baseUrl: process.env.POLARIS_BASE_URL! });

export async function POST(req: Request) {
  let event;
  try {
    event = polaris.webhooks.verify(await req.text(), req.headers.get("polaris-signature"), process.env.POLARIS_WEBHOOK_SECRET!);
  } catch (err) {
    if (err instanceof PolarisSignatureVerificationError) return new Response("bad signature", { status: 400 });
    throw err;
  }
  if (event.type === "payment.succeeded") await fulfil(event.data.orderId, event.data.amount);
  if (event.type === "plan.opened") await fulfil(event.data.orderId, event.data.principal);
  return new Response(null, { status: 204 });
}
```

Express: `app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => { const event = polaris.webhooks.verify(req.body, req.headers["polaris-signature"], secret); … })`
(a Buffer body and a header array are both accepted).

**The signature.** `Polaris-Signature: t=1790426298,v1=<hex>`, where `v1` is
`HMAC-SHA256(secret, "${t}.${rawBody}")` in hex and `secret` is the endpoint's
whole `whsec_…` string. A delivery whose `t` is more than 300 seconds from your
clock (either way) is refused, so a captured request can't be replayed later.
While a secret rotates, a header can carry several `v1=` values; one match is
enough. A failure throws `PolarisSignatureVerificationError` with a `reason`:
`missing_header`, `malformed_header`, `no_signatures`,
`timestamp_outside_tolerance`, `signature_mismatch`, `missing_secret` or
`invalid_payload`.

`verify` is synchronous and runs everywhere (Node's crypto when present, a
tested pure-JS HMAC otherwise). `verifyAsync` does the same through Web Crypto.
Standalone versions are exported too: `verifyWebhook`, `verifyWebhookAsync`,
`signWebhookPayload`.

**At least once.** Deliveries retry, so key on `event.id` and treat a repeat as
a no-op. Every event comes from an indexed chain event, never from a browser.

| `type` | `data` |
|---|---|
| `payment.succeeded` | `orderId, sessionId, metadata, paymentId, mode: "now", merchant, payer, amount, fee, currency, txHash, chainId` |
| `plan.opened` | `orderId, sessionId, metadata, planId, mode: "later", merchant, borrower, principal, interest, total, installments, intervalSeconds, schedule[{ index, amount, dueAt }], currency, txHash, chainId` |
| `installment.collected` | `planId, orderId, installment, installments, amount, remaining, txHash, chainId` |
| `installment.failed` | `planId, orderId, installment, amount, reason ("insufficient_funds" \| "allowance_lost" \| "other"), attempt, nextAttemptAt, chainId` |
| `plan.completed` | `planId, orderId, total, txHash, chainId` |
| `plan.liquidated` | `planId, orderId, outstanding, recovered, txHash, chainId` |
| `subscription.charged` | `subscriptionId, planId, merchant, subscriber, amount, fee, period, nextChargeAt, orderId, sessionId, txHash, chainId` |
| `subscription.canceled` | `subscriptionId, planId, merchant, subscriber, canceledBy, txHash, chainId` |
| `payout.paid` | `payoutId, amount, destination, automatic, txHash, chainId` |

Amounts are USD decimal strings with 2 to 6 decimals (AUSD's precision):
`"25.00"`, `"50.383562"`, never base units. The types are exported:
`WebhookEvent<"plan.opened">`, `PlanOpenedData`, …

**Checking an event's shape.** `verify` proves an event came from Polaris; it
doesn't re-check the payload. `validateWebhookEvent(event)` does: it returns
every way an event differs from its type (`[{ path: "data.amount", message:
"… this looks like AUSD base units" }]`), or `[]`. `assertWebhookEvent` throws
instead. Use them in the tests of anything that builds events: a mock of
Polaris, the API's emitter, an indexer's outbox.

---

## Browser: `createPolaris`

```ts
import { createPolaris } from "polarispay-sdk";

const polaris = createPolaris({ publishableKey: "pk_test_…" });
```

| Option | |
|---|---|
| `publishableKey` | `pk_test_…` defaults to `MONAD_TESTNET`, `pk_live_…` to `MONAD`. A secret key is refused outright. |
| `chain` | A preset, or your own addresses: `{ ...MONAD_TESTNET, payments: "0x…" }` |
| `checkoutOrigin` | Where the hosted checkout lives. Default `https://pay.polarispay.app`, or `http://localhost:3000` when your page is on localhost. Results are accepted only from this origin. |
| `relayUrl` | Makes `pay()` gasless (below). |
| `provider` | Any EIP-1193 provider. Default `window.ethereum`. |

### `openCheckout(sessionOrUrl, options?)`

Takes a session, its id, its URL, or a function or promise that returns one
(your server call). Resolves with:

| `status` | |
|---|---|
| `"completed"` | with `mode`, `orderId`, `txHash`, `paymentId`, `planId`, `subscriptionId` |
| `"canceled"` | the buyer pressed *Cancel* |
| `"closed"` | the buyer closed the window (or your `signal` aborted) |
| `"expired"` | the session expired while open |
| `"timeout"` | nothing after `timeoutMs` (default 30 min); the window is closed |
| `"redirected"` | the page went to the checkout instead: phones, or a blocked popup |

- **Desktop:** a centred 440 × 760 popup, with a dimmed *"Finish paying in the
  Polaris window"* panel on your page that brings it back or cancels
  (`overlay: false` to skip it).
- **Phones and in-app browsers:** a full-page redirect; the buyer returns to
  `successUrl`.
- **Blocked popup:** falls back to a redirect (`onBlocked: "error"` to reject
  with `popup_blocked` instead).
- **A function or promise:** the window opens *inside the click*, with a Polaris
  loading page, and navigates once your server returns the session. Opening
  after an `await` is what gets popups blocked.
- A second call while the checkout is open focuses it instead of opening another.

The result arrives by `postMessage`, and only from the checkout origin and the
window the SDK opened. It's a hint for your UI: **fulfil from the webhook** or
`sessions.retrieve`.

`redirectToCheckout(sessionOrUrl)` always navigates. `checkoutUrl(…)` returns the URL.

### Direct pay: `pay({ merchant, amount, orderId })`

For when you have a merchant address and a wallet, and no session:

```ts
const polaris = createPolaris({ publishableKey: "pk_test_…", relayUrl: "https://your.api/api/v1/relay/payments" });
const result = await polaris.pay({ merchant: "0xMerchant…", amount: "25.00", orderId: crypto.randomUUID() });
if (result.ok) show(result.explorerUrl); else show(result.error);
```

1. The wallet signs one ERC-3009 `ReceiveWithAuthorization` naming
   `PolarisPayments` as the payee and `keccak256(merchant, orderId)` as the
   nonce. The token's EIP-712 domain is read from the token (AUSD's is
   *"Agora Dollar"*, not its `name()`), and the signature is checked to recover
   to the payer before anything is sent.
2. **With `relayUrl`** the Polaris relayer submits
   `PolarisPayments.payWithAuthorization` and pays the gas: the buyer needs AUSD
   and nothing else. **Without it** the wallet sends the transaction, with the gas
   limit set from `eth_estimateGas` + 15% (Monad charges gas on the limit).

The relayer can't redirect the money: change the merchant or the order and the
nonce changes, and AUSD rejects the signature. Before signing, `pay()` checks the
order isn't already paid, isn't quoted at another price, and that the buyer has
the balance, so the buyer isn't asked to sign something that will fail.

It never throws for anything the buyer can cause; it returns
`{ ok, error, transactionHash, explorerUrl, paymentId, payer, amount, relayed }`
with `error` written for the buyer ("You cancelled the request.", "This order has
already been paid."). Configuration mistakes (an undeployed contract, a bad
address) do throw. The original error is kept as `cause`: a wallet on another
network that the buyer won't switch reads *"Switch your wallet to Monad Testnet
to pay."*, with `cause.code === "wrong_chain"` so you can show a switch step.
`onStage` reports `connecting → signing → submitting →
confirming` for your UI, and `getPayment({ merchant, orderId })` reads the
on-chain record so you can match `payer` and `amount` before fulfilling.

### Pay in 4 pricing

```ts
polaris.quote("200.00"); // or quotePayIn4("200.00")
// { each: "50.38", interest: "1.53", total: "201.53", aprBps: 1000,
//   installments: [{ index: 1, amount: "50.38", amountBaseUnits: 50383562n, dueInSeconds: 604800 }, …] }
```

The loan engine's arithmetic, in base units: 10% APR, pro-rated over four weekly
instalments, charged to the buyer, never to you. The buyer pays nothing at
checkout: instalment *i* falls due `i × intervalSeconds` later (the first a
week out), and its `amountBaseUnits` is the step on `PolarisLoanEngine.thresholdFor`'s
rounded-up ladder, so the quote is what the keeper collects, unit for unit. Each
`amount` is that step with the running total rounded to the cent, so the rows
always add up to the `total` you show, and each is within a cent of what is
drawn ($200 reads 50.38, 50.39, 50.38, 50.38 = 201.53). Every Polaris plan is
10% APR (the engine has no other rate), so the components always show the
interest and the APR and never call a plan interest-free; `aprBps` other than
1000 exists for tests.

### Split-the-bill links: `splits.link(params)`, `splits.open(params)`

A split is the organiser's own request for money from friends: they open it
with Face ID in the Polaris app, share one link, and each friend pays their
share there, straight to the organiser. An app can't create one for them, but
it can hand them the Polaris app's "Split a bill" screen filled in (a
restaurant's "Split this bill", a ride's "Split the fare"). They review it and
confirm; nothing is created until they do.

```ts
polaris.splits.open({ total: "120.00", description: "Dinner at Lucia", people: 4, names: ["Sam", "Priya", "Jon"] });
polaris.splits.link({ total: "120.00", shares: [{ name: "Sam", amount: "45" }, { name: "Priya", amount: "30.50" }] });
// "https://pay.polarispay.app/split/new?amount=120.00&share=Sam%3A45.00&share=Priya%3A30.50"
```

`people` (2 to 20) counts the organiser unless `includeOrganiser: false`;
`shares` (up to 19 named amounts) wins over `people`, and what's left of the
bill is the organiser's part. `splitLink(appOrigin, params)` is the same as a
plain function.

### 0.2 methods

`subscribe`, `cancelSubscription`, `payLater`, `lockCollateral`,
`withdrawCollateral`, `getCredit` and `canPayLater` work as in 0.2 (the buyer
holds gas and approves). See [Migrating from 0.2](#migrating-from-02).

---

## React

```tsx
import { PolarisProvider, PolarisMessaging, PolarisCheckoutButton, PolarisPayButton, usePolarisCheckout } from "polarispay-sdk/react";

<PolarisProvider publishableKey="pk_test_…">
  <PolarisMessaging amount="201.50" />                      {/* product page */}
  <PolarisCheckoutButton createSession={createSession} amount="201.50" />
  <PolarisPayButton merchant="0x…" amount="25.00" orderId={() => crypto.randomUUID()} />
</PolarisProvider>;
```

- **`<PolarisCheckoutButton>`**: `session` or `createSession`, `amount`,
  `theme` (`"dark"` ink with the lime star, `"lime"` the Polaris CTA, `"light"`),
  `size` (`sm | md | lg`), `block`, `label`, `aprBps`, `installments`, and
  `onSuccess / onCancel / onResult / onError`. States: *Opening Polaris…*,
  *Finish in the Polaris window*, *Paid with Polaris*.
- **`<PolarisMessaging amount>`**: *"or 4 payments of $50.38 with ✦ Polaris
  Learn more"*. The popover shows the four payments and when each is due (the
  first in a week; nothing today), the total and the interest, how it works,
  and the credit line's terms. It renders nothing outside
  `minAmount`–`maxAmount` (default $1–$5,000). `theme="dark"` for a dark popover.
  `paused` (true, or `credit.guard()`'s `message`) says *"✦ Polaris Pay in 4 is
  paused by our risk guard; pay now works as usual."* instead of the offer.
- **`<PolarisPayButton>`**: direct wallet pay with stage labels (*Confirm in
  your wallet*, *Paying…*) and a *View receipt* link.
- **`usePolarisCheckout()`**: `{ status, result, error, busy, open, redirect, cancel, reset }`
  for your own button.

**Accessible:** real `<button>`s, `aria-busy`, `aria-describedby` on the Pay in 4
line, a polite live region for progress, `role="alert"` for errors, a labelled
dialog that takes focus, closes on Escape and outside clicks, and returns focus.
Motion stops under `prefers-reduced-motion`.

**Server rendering:** everything renders on the server and hydrates without
mismatches (no dates, no randomness, fixed number locale). Components are marked
`"use client"`.

**Theming, no stylesheet:** the components render their own CSS (hoisted and
de-duplicated on React 19). Override any of these on an ancestor:

| Variable | Default |
|---|---|
| `--polaris-font` | Satoshi, then the system UI font |
| `--polaris-radius` | `999px` (pill) |
| `--polaris-button-height` | `54px` |
| `--polaris-button-bg` / `-fg` / `-hover` / `-border` | per theme (dark: `#0F1011` / `#F5F5F5`) |
| `--polaris-accent` | `#9CEF5E` (lime) |
| `--polaris-focus` | `#9CEF5E` |
| `--polaris-text`, `--polaris-muted` | inherited text, 64% of it |
| `--polaris-danger` | `#D83B3B` |
| `--polaris-surface`, `--polaris-surface-text`, `--polaris-surface-muted`, `--polaris-surface-2`, `--polaris-hairline` | popover colours |
| `--polaris-card-radius` | `28px` |
| `--polaris-message-size` | `14px` |

---

## Test mode

- `pk_test_` / `sk_test_` keys run against **Monad testnet** (chain 10143) and
  AUSD at `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`. Nothing real moves.
- Local stack: Polaris for Business on `http://localhost:3100` (`baseUrl`), the
  Polaris app and hosted checkout on `http://localhost:3000` (the SDK's default
  `checkoutOrigin` whenever your page runs on localhost).
- Walkthrough: create a session with your `sk_test_` key, click the button, pay
  in the checkout with a test account, and watch `payment.succeeded` arrive.
  *Developers → Webhooks → Send test event* in the dashboard signs a test
  delivery exactly like a live one (`livemode: false`).
- Unit-test your handler without a network:

  ```ts
  const payload = JSON.stringify({ id: "evt_test", object: "event", type: "payment.succeeded", createdAt: new Date().toISOString(), livemode: false, merchantId: "mer_test", data: { orderId: "o_1" } });
  const header = polaris.webhooks.generateTestHeader({ payload, secret: "whsec_test" });
  await handler(new Request("http://x", { method: "POST", body: payload, headers: { "polaris-signature": header } }));
  ```

---

## Chains and deployments

`MONAD_TESTNET` (10143) and `MONAD` (143) carry the RPC, explorer, AUSD and
every Polaris contract. Contract addresses come from `src/deployments.ts`, which
is **generated** from `packages/contracts/deployments/monad-testnet.json` and
`monad.json`:

```bash
pnpm --filter polarispay-sdk gen:deployments   # also runs on every build
pnpm --filter polarispay-sdk check:deployments # CI: fails if stale
```

Until a network has a deployment file its Polaris contracts are the **zero
address**, and any call that needs one throws `contract_not_deployed` naming the
contract, rather than signing for a contract that isn't there. The SDK never
ships a made-up address. Pass your own with `chain: { ...MONAD_TESTNET, payments: "0x…" }`.

`SEPOLIA` is the 0.2 deployment, kept for 0.2 integrations.

---

## HTTP API

What the SDK calls, for anyone implementing the API or calling it directly.
Every response is `{ "data": … }` on success and
`{ "error": { "code": "…", "message": "…", "param"?: "…" } }` on failure, with a
`Polaris-Request-Id` header.

### `POST {baseUrl}/api/v1/checkout/sessions`

```http
Authorization: Bearer sk_test_…
Content-Type: application/json
Idempotency-Key: order_2041
Polaris-Client: polarispay-sdk/0.3.0
```

```json
{
  "amount": "200.00",
  "currency": "USD",
  "description": "Brand identity package",
  "lineItems": [{ "name": "Logo", "quantity": 1, "unitAmount": "150.00" }, { "name": "Revisions", "quantity": 2, "unitAmount": "25.00" }],
  "modes": ["now", "later"],
  "subscription": null,
  "successUrl": "https://studio.example/thanks?session={CHECKOUT_SESSION_ID}",
  "cancelUrl": "https://studio.example/cart",
  "orderId": "INV-2041",
  "metadata": { "invoice": "2041" }
}
```

The SDK always sends every field (`[]`, `null` or `{}` when unset), amounts as
two-decimal strings. `subscription` is `{ "interval", "intervalCount" }` exactly
when `modes` includes `"subscribe"`.

**201** (or **200** when the idempotency key replays an earlier request):

```json
{
  "data": {
    "id": "cs_test_a1B2c3D4e5F6g7H8",
    "object": "checkout.session",
    "url": "https://pay.polarispay.app/pay/cs_test_a1B2c3D4e5F6g7H8",
    "status": "open",
    "paymentStatus": "unpaid",
    "livemode": false,
    "amount": "200.00",
    "currency": "USD",
    "description": "Brand identity package",
    "lineItems": [{ "name": "Logo", "quantity": 1, "unitAmount": "150.00", "amount": "150.00" }, { "name": "Revisions", "quantity": 2, "unitAmount": "25.00", "amount": "50.00" }],
    "modes": ["now", "later"],
    "subscription": null,
    "successUrl": "https://studio.example/thanks?session={CHECKOUT_SESSION_ID}",
    "cancelUrl": "https://studio.example/cart",
    "orderId": "INV-2041",
    "metadata": { "invoice": "2041" },
    "createdAt": "2026-10-01T12:00:00.000Z",
    "expiresAt": "2026-10-02T12:00:00.000Z",
    "completedAt": null,
    "payment": null
  }
}
```

- `id` matches `^cs_(test|live)_[A-Za-z0-9]{8,128}$`.
- `status`: `open` → `complete` (paid, or the Pay in 4 plan opened, or the
  first subscription charge) or `expired`. `paymentStatus`: `unpaid` | `paid`.
- `payment`, once complete: `{ "mode", "payer", "txHash", "chainId", "paymentId", "planId", "subscriptionId" }`
  (the ids that don't apply are `null`).
- Reusing an `Idempotency-Key` with different parameters: **409**
  `idempotency_key_reused`; while the first request is still running: **409**
  `idempotency_in_progress` (the SDK retries that one).
- Errors: **400** `invalid_…` with `param`, **401** `invalid_api_key`, **403**,
  **429** with `Retry-After`, **5xx**.

### `GET {baseUrl}/api/v1/checkout/sessions/{id}`

`Authorization: Bearer sk_test_…`. **200** `{ "data": CheckoutSession }`, **404**
`not_found`.

### `GET {baseUrl}/api/public/credit-guard`

Public, no key needed. **200** `{ "data": CreditGuardStatus }` (`credit.guard()` above).

### `GET {baseUrl}/api/public/splits/{id}`

Public, no key needed. **200** `{ "data": SplitStatus }` (`splits.retrieve()` above);
**404** `split_not_found`; **400** for an id that isn't 32 bytes of hex.

### Relay: `POST {relayUrl}` (direct pay)

```http
Authorization: Bearer pk_test_…
Content-Type: application/json
```

```json
{
  "type": "payWithAuthorization",
  "chainId": 10143,
  "contract": "0x…PolarisPayments",
  "payer": "0x…",
  "merchant": "0x…",
  "amount": "25000000",
  "orderId": "INV-2041",
  "validAfter": "0",
  "validBefore": "1790430000",
  "nonce": "0x…keccak256(merchant, orderId)",
  "signature": "0x…65 bytes r‖s‖v"
}
```

`amount` is AUSD base units. The relayer must refuse any `contract` but
PolarisPayments and any `chainId` but its own, recompute the nonce, and submit
`payWithAuthorization(payer, merchant, amount, orderId, validAfter, validBefore, v, r, s)`.
**200/201** `{ "data": { "txHash": "0x…", "status": "submitted" | "confirmed", "paymentId"?: "0x…" } }`;
errors as above, and their `message` is shown to the buyer.

### Checkout ↔ page messages

The hosted checkout posts to `window.opener` with the origin of the session's
`successUrl` as the target (never `"*"`):

```js
{ type: "polaris:checkout", version: 1, event: "ready" | "completed" | "canceled" | "expired", sessionId,
  mode?, orderId?, txHash?, paymentId?, planId?, subscriptionId? }
```

It's opened with `?display=popup`; in that mode it posts its result and closes
instead of redirecting. `openCheckout` resolves the moment `completed` arrives
but leaves the window open, so the buyer sees the receipt; the checkout closes
itself 2.5 s later (the SDK closes it at 3.5 s if it is still open). A canceled
or expired checkout is closed at once. It must not send `Cross-Origin-Opener-Policy:
same-origin`, which would sever `window.opener`. `createCheckoutMessage()` builds
these messages.

### Webhook deliveries

`POST` to the endpoint with `Content-Type: application/json`,
`Polaris-Signature: t=…,v1=…`, `Polaris-Event: payment.succeeded` and
`Polaris-Delivery-Attempt: 1`, and the body:

```json
{ "id": "evt_…", "object": "event", "type": "payment.succeeded", "createdAt": "2026-10-01T12:00:00.000Z", "livemode": false, "merchantId": "mer_…", "data": { … } }
```

---

## Migrating from 0.2

- `createPolaris({ publishableKey })` targets Monad. With neither a key nor a
  `chain`, it still targets the 0.2 Sepolia deployment and warns once; pass
  `chain: SEPOLIA` to keep that explicitly. The fallback goes away in 0.4.
- On Monad, `pay()` is one signature through `payWithAuthorization` (gasless with
  `relayUrl`) instead of approve-then-pay. On `SEPOLIA` it's the 0.2 flow.
- `contracts` is still accepted as an alias of `chain`, and `PolarisContracts`
  objects are upgraded automatically.
- `PayWithPolarisBNPL` and `POLARIS_SEPOLIA` are still exported from
  `polarispay-sdk/react`.
- Results carry `cause` (the raw error) next to `error`, and "Not enough ETH"
  names the chain's gas token.

---

## Developing

From the repo root, one command sets everything up and runs the suite:

```bash
pnpm install && pnpm --filter polarispay-sdk test
```

```bash
pnpm --filter polarispay-sdk typecheck
pnpm --filter polarispay-sdk build        # dist/esm, dist/cjs, dist/types
pnpm --filter polarispay-sdk test:chain   # the built SDK against PolarisPayments on Hardhat's local network
```

`test:chain` compiles `packages/contracts`, deploys `MockAUSD` and
`PolarisPayments` on Hardhat's in-process network, and pays through the built
SDK twice: once from a wallet, once through a relay for a buyer who holds no gas
at all. Nothing touches a public network.

MIT licensed.

# Changelog

## Unreleased (0.3.x)

Retargeted from its first chain to [Arc](https://arc.io), Circle's stablecoin
chain. The API is unchanged except for the chain and token constants below.

### Changed

- **Chain presets**: `ARC_TESTNET` (key `arc-testnet`, chain 5042002,
  `https://rpc.testnet.arc.io`, `https://explorer.testnet.arc.io`) and `ARC`
  (key `arc`, chain 5042, `https://rpc.mainnet.arc.io`, `https://explorer.arc.io`)
  replace the previous presets. `publishableKey` picks them as before: test keys
  `ARC_TESTNET`, live keys `ARC`. `SEPOLIA` (0.2) is unchanged.
- **The dollar is USDC** (6 decimals). `USDC` exports Circle's USDC address on
  both networks (`0x3600…0000`), replacing the previous dollar-token constant;
  `EURC` is new. The native currency is USDC too: gas on Arc is paid in USDC,
  and through `relayUrl` Polaris pays it.
- **`DEPLOYMENTS`** keys are `arcTestnet` and `arc`, generated from
  `packages/contracts/deployments/arc-testnet.json` and `arc-mainnet.json`.
  Neither is deployed yet, so both presets carry zero addresses and
  `assertDeployed` refuses them until they are.
- **`collector`** is now the Polaris keeper's `CollectionsReceiver` (same field
  name; the deployment record's `CollectionsReceiver` maps to it).
- **EIP-712 domain**: USDC and EURC have no ERC-5267 `eip712Domain()`. `pay()`
  now builds the token domain from `name()` and `version()` (default `"2"`)
  and signs only if it hashes to the token's `DOMAIN_SEPARATOR()`; ERC-5267 is
  the fallback for other tokens, and is checked against `DOMAIN_SEPARATOR()`
  too.
- **The credit guard** is an on-chain contract that reads the pool live
  (reasons `low_cash`, `bad_debt`, `owner_pause`). `CreditGuardReason` and
  `CreditGuardStatus` keep their shapes; `depeg`, `stale_price`, `stale` and
  `never` are no longer reported.
- Copy: payments are final in under a second; the pay button reads
  "Confirming on Arc…" and "Settled on Arc."

## 0.3.0

Polaris with Stripe's ergonomics.

### Added

- **`polarispay-sdk/server`**: `createPolarisServer({ secretKey, baseUrl })` with
  `checkout.sessions.create(params, { idempotencyKey })` and
  `checkout.sessions.retrieve(id)`. Parameters are validated locally; requests
  retry on network errors, 429 and 5xx with backoff and `Retry-After`, always
  under an idempotency key. Refuses publishable keys, plain http off localhost,
  and running in a browser.
- **Webhooks**: `webhooks.verify(rawBody, signatureHeader, secret)` (and
  `verifyAsync`, `generateTestHeader`), Stripe-style `t=…,v1=…` HMAC-SHA256
  signatures over `${t}.${body}` with a 300 s tolerance either way, several
  `v1` values during secret rotation, and typed events for all nine types:
  `payment.succeeded`, `plan.opened`, `installment.collected`,
  `installment.failed`, `plan.completed`, `plan.liquidated`,
  `subscription.charged`, `subscription.canceled`, `payout.paid`. Synchronous
  on every runtime: Node's crypto when present, a tested pure-JS HMAC otherwise.
- **Hosted checkout** from the browser: `createPolaris({ publishableKey })`
  with `openCheckout` (a centred popup with a page overlay on desktop, a
  redirect on phones or when the popup is blocked, results by origin-checked
  `postMessage`, close and timeout handling, and a popup that opens inside the
  click even while your server creates the session) and `redirectToCheckout`.
- **Direct pay**: `pay({ merchant, amount, orderId })` with any
  EIP-1193 provider through `PolarisPayments.payWithAuthorization`. One ERC-3009
  signature, the domain read from the token, the signer checked before sending,
  gasless through a relayer when `relayUrl` is set. `getPayment` reads the
  on-chain record.
- **Chain presets** for the 0.3 networks (now `ARC_TESTNET` and `ARC`, see
  above), with addresses generated from
  `packages/contracts/deployments` into `src/deployments.ts`. Undeployed
  contracts are the zero address and refused at runtime with
  `contract_not_deployed`.
- **React**: `PolarisCheckoutButton`, `PolarisMessaging` (the product-page
  "or 4 payments of $50.38 with Polaris" line and its Learn more popover),
  `PolarisPayButton`, `usePolarisCheckout`, `PolarisProvider` and
  `PolarisMark`. CSS-variable theming with no stylesheet to import,
  server-rendered, accessible.
- `quotePayIn4` / `polaris.quote`: Pay in 4 priced and scheduled exactly as
  the loan engine does it (10% APR pro-rated; $200 is 4 × $50.38). Instalments
  follow `PolarisLoanEngine.thresholdFor`'s rounded-up ladder, unit for unit,
  and fall due at `(i + 1) × interval`: nothing is paid at checkout, and the
  first payment is a week later.
- `validateWebhookEvent` / `assertWebhookEvent`: a runtime check that an event
  matches its `WebhookEvent` type, envelope and every `data` field with its
  format (amounts in dollars with 2 to 6 decimals, `USD`, `now` / `later`,
  0x hashes and addresses, ISO times, one schedule row per instalment). For
  the tests of anything that builds events; `verify` is unchanged.

### Changed

- `createPolaris` targets the 0.3 network when given a publishableKey (test
  keys: its testnet, live keys: its mainnet). `pay()` there is a signature, not
  approve-then-pay.
- ethers is loaded lazily, only when a wallet method runs.
- Wallet errors name the chain's gas token instead of always saying ETH, and
  results include the original error as `cause`.

### Compatibility

- With neither a publishableKey nor a chain, `createPolaris()` still targets
  the 0.2 Sepolia deployment (with a one-time warning). This fallback will be
  removed in 0.4.
- `contracts` still works as an alias of `chain`; `SEPOLIA`,
  `PayWithPolarisBNPL`, `POLARIS_SEPOLIA` and the 0.2 wallet methods
  (`subscribe`, `payLater`, `getCredit`, …) are unchanged.

### Fixed

- `PayWithPolarisBNPL` listed the first instalment as due "Today" while
  saying nothing is taken today. Its schedule now starts one interval after
  checkout, as the loan engine collects it.
- `quotePayIn4`'s displayed instalments could miss the displayed total by a
  cent or more ($189 at 10%: 4 × 47.61 against 190.45). They are now the steps
  of the running total rounded to the cent, so they always add up to it.
- A buyer on the wrong network who declined the switch (or declined adding
  the chain) was told "You cancelled the request." `pay()` and the 0.2 flows
  now answer "Switch your wallet to Arc Testnet to pay." with a `wrong_chain`
  `PolarisError` as `cause`, and never ask for a signature.
- `PolarisMessaging` and `PolarisCheckoutButton` threw while rendering when a
  quoted figure rounded to $0.00 (a minutes-long demo plan's interest, or a
  cart of a few cents). They show $0.00 instead, and hourly plans read
  "In 1 hour … every hour" rather than "In 60 min".

## 0.2.1

- Split the React widget into `polarispay-sdk/react` so React is optional.

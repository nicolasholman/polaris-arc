# Polaris on Arc: Arc Microgrants submission

**Stripe for every app on Arc: one link to get paid now, later, or every month, in USDC.**

## Description (DoraHacks, under 150 words)

Polaris gives any app a payment link with credit built in. A buyer opens the
link, creates an account with Face ID, and pays in USDC on Arc: in full, in
four instalments against an on-chain credit line, or by subscription. The
merchant is paid in full, final in under a second. Buyers never buy gas:
Arc's gas is USDC, and Polaris's relayer pays it, so every action is just a
signature. Money can come from anywhere: buyers add USDC from Ethereum,
Base, Arbitrum, Avalanche, OP or Polygon through CCTP V2, and send dollars
or euros (EURC) to anyone by link. Every checkout carries the merchant's
order reference on chain in an Arc memo. A keeper collects instalments and
writes credit reviews; a credit guard pauses new loans the moment the USDC
pool runs short. Merchants get a dashboard, an SDK, webhooks and payouts.

## What it uses Arc for

- **USDC as money and as gas**: the credit pool, payments, plans and payouts
  are USDC; the relayer and keeper hold nothing else; buyers and merchants
  hold no gas at all (ERC-2612 / ERC-3009 signatures on Arc's USDC).
- **Sub-second finality**: "Paid" and the merchant's webhook land before the
  checkout popup closes; no confirmation counts.
- **CCTP V2, pay from any chain**: burn on six source chains, Polaris mints
  on Arc from Circle's attestation and pays Arc's gas.
- **EURC**: euro send-by-link for cross-border payments, on a second
  PolarisSend escrow.
- **Arc transaction memos**: every checkout goes through Arc's Memo contract
  with the order key, for on-chain reconciliation.
- **Arc's explorer API** for verification and for reading a buyer's Arc
  history during credit reviews.
- One-command **mainnet** switch (`NETWORK=mainnet`), with caps on every pooled
  balance.

## Demo steps

1. `pnpm install && DEMO_FAST_PLANS=1 pnpm demo:local` (or run against Arc
   testnet: `pnpm e2e:testnet`, README "On Arc testnet").
2. Open the demo shop (http://127.0.0.1:3600), add the Arc Lamp to the bag,
   **Check out with Polaris**. The checkout opens in a popup: create an
   account with Face ID, **Add money** (on Arc testnet: from another chain
   with CCTP, or Circle's faucet), and **Pay now**. The order turns paid by
   webhook; the receipt links the transaction.
3. Check out again with **Pay in 4**: **Boost** locks a little USDC to open a
   line (or **Raise your limit** asks the keeper for a review), then four
   instalments, nothing due today; the merchant is paid in full at once.
4. Wait a minute: the keeper collects instalment 1 (the dashboard's
   **Automation** page shows the run and its transaction).
5. In the app, **Send** → **Euros** → a link; open it in another browser and
   claim the EURC.
6. The merchant dashboard (http://localhost:3100/dashboard) shows the
   payments, the plan, the webhooks, the keeper and the credit guard.

Contracts, hashes and verification: `packages/contracts/deployments/arc-testnet.json`.

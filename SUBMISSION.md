# Polaris on Arc: Arc Microgrants submission

Live: https://polaris-arc-lemon.vercel.app (Arc testnet)


**Stripe for every app on Arc: one link to get paid now, later, or every month, in USDC.**

## Description (DoraHacks, under 150 words)

Polaris gives any app a payment link with credit built in. A buyer opens the
link, creates an account with Face ID, and pays in USDC on Arc: in full, in
four instalments against an on-chain credit line, or by subscription. The
merchant is paid in full, final in under a second. Buyers never buy gas:
Arc's gas is USDC, and Polaris's relayer pays it, so every action is just a
signature. Buyers pay from any chain: a Circle Gateway balance in one
signature, CCTP V2 (with hooks), or one transaction on Base or Ethereum
over Chainlink CCIP. Every checkout carries its order reference in an Arc
memo. A keeper collects instalments; a credit guard pauses new loans when
the pool runs short (and, on mainnet, when Chainlink's USDC feed depegs).
Idle pool cash can be parked in USYC (tested on a fork). Merchants get a dashboard, an SDK and webhooks.

## What it uses Arc for

- **USDC as money and as gas**: the credit pool, payments, plans and payouts
  are USDC; the relayer and keeper hold nothing else; buyers and merchants
  hold no gas at all (ERC-2612 / ERC-3009 signatures on Arc's USDC).
- **Sub-second finality**: "Paid" and the merchant's webhook land before the
  checkout popup closes; no confirmation counts.
- **Circle Gateway**: a unified USDC balance on any Gateway chain, spent on
  Arc with one EIP-712 signature (built and unit-tested; checked against Circle's testnet Gateway API,
  not run end to end).
- **CCTP V2, pay from any chain**: burn on a source chain, Polaris mints on
  Arc from Circle's attestation and pays Arc's gas; with
  `depositForBurnWithHook` the same mint pays the order
  (`PolarisCctpHookReceiver`, deployed on testnet). Not run with a real
  source-chain burn.
- **Chainlink CCIP**: pay a link, or a Pay in 4 instalment, from Base or
  Ethereum in one transaction: CCTP moves the dollars, CCIP carries the
  order to a defensive receiver on Arc (allowlist, stored failures, either
  arrival order). Receiver deployed on testnet; tested with Chainlink Local
  and the real Arc router on a fork. No live cross-chain send yet.
- **Chainlink Data Feeds**: mainnet only (Arc testnet has no feeds). USDC / USD
  guards new credit (depeg or stale price pauses Pay in 4; fork-tested against
  the real mainnet feeds); EURC / USD prices euro links, display only.
- **USYC**: idle credit-pool cash parked through Circle's Teller and
  brought back (round trip rehearsed on an Arc fork; needs allowlisting).
- **EURC**: euro send-by-link on a second PolarisSend escrow (deployed on
  testnet; the live link needs testnet EURC and was not run).
- **Arc transaction memos**: every checkout goes through Arc's Memo contract
  with the order key, for on-chain reconciliation.
- **Arc's explorer API** for reading a buyer's Arc history during credit
  reviews (see docs/JUDGE-REPORT.md for contract verification).
- One-command **mainnet** switch (`NETWORK=mainnet`), with caps on every pooled
  balance.

## Demo steps

1. `pnpm install && DEMO_FAST_PLANS=1 pnpm demo:local` (or run against Arc
   testnet: `pnpm e2e:testnet`; the run that was done is in
   docs/E2E-TESTNET.md).
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

Contracts and hashes: `packages/contracts/deployments/arc-testnet.json`.
Status of every claim (Live / Fork / Not run): README "Arc stack" and
docs/JUDGE-REPORT.md.

<!-- MAINNET-ADDRESSES -->
## Addresses — live mainnet and testnet

Mainnet **5042: Live**, deployed 2026-10-14. [All mainnet addresses and transaction receipts](docs/MAINNET-DEPLOYMENT.md).
Testnet **5042002: Live**; [testnet deployment](packages/contracts/deployments/arc-testnet.json) and [testnet evidence](docs/E2E-TESTNET.md).

- USDC: [0x3600000000000000000000000000000000000000](https://explorer.arc.io/address/0x3600000000000000000000000000000000000000).
- EURC: [0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1](https://explorer.arc.io/address/0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1).
- ScoreManager: [0x02B8F7938e7B3c7D68894b12717283315F782b9b](https://explorer.arc.io/address/0x02B8F7938e7B3c7D68894b12717283315F782b9b).
- PolarisLoanEngine: [0xDe99BF4827C7c7860DE8e5b9e204B4f94dD1cFFC](https://explorer.arc.io/address/0xDe99BF4827C7c7860DE8e5b9e204B4f94dD1cFFC).
- PolarisPayments: [0x9A110BeEe29e24C40CB993154286613D827f1a86](https://explorer.arc.io/address/0x9A110BeEe29e24C40CB993154286613D827f1a86).
- MerchantRegistry: [0xcE806E4bf02ef60bd960D25a170E97BEc9870141](https://explorer.arc.io/address/0xcE806E4bf02ef60bd960D25a170E97BEc9870141).
- CollateralVault: [0xd7Bf04137472BC9Bb6D76af795DC05c6696E1356](https://explorer.arc.io/address/0xd7Bf04137472BC9Bb6D76af795DC05c6696E1356).
- BatchSettlement: [0x79890eE43F520F232dCcd567B6F021A44d3cf516](https://explorer.arc.io/address/0x79890eE43F520F232dCcd567B6F021A44d3cf516).
- PolarisSend: [0x8aA2fD0F5f928D7b0ee8F32a616e968689212Bc3](https://explorer.arc.io/address/0x8aA2fD0F5f928D7b0ee8F32a616e968689212Bc3).
- PolarisSendEURC: [0xC772b6569E160cC5ED5E697374D4DADE6959a27C](https://explorer.arc.io/address/0xC772b6569E160cC5ED5E697374D4DADE6959a27C).
- PolarisSplit: [0x5F368a741F490F365fB9b72a1707bee7a03AD851](https://explorer.arc.io/address/0x5F368a741F490F365fB9b72a1707bee7a03AD851).
- PolarisCheckout: [0x804C0f6F302a71cF36346a2F6936E034ea95EaAD](https://explorer.arc.io/address/0x804C0f6F302a71cF36346a2F6936E034ea95EaAD).
- CollectionsReceiver: [0xe62AEe7e282B3A248d82b80CB1e9d28021B23AdE](https://explorer.arc.io/address/0xe62AEe7e282B3A248d82b80CB1e9d28021B23AdE).
- UnderwritingReceiver: [0xe1d5E1089142fD8304971A820918634265734471](https://explorer.arc.io/address/0xe1d5E1089142fD8304971A820918634265734471).
- CreditGuard: [0xc79A4Aa7396c3e67ee461C3A92fFc4258e49361B](https://explorer.arc.io/address/0xc79A4Aa7396c3e67ee461C3A92fFc4258e49361B).
- PolarisCCIPReceiver: [0x106364d30fBE8F05ca83b9c0F202EAE41b2C8a3e](https://explorer.arc.io/address/0x106364d30fBE8F05ca83b9c0F202EAE41b2C8a3e).
- PolarisCctpHookReceiver: [0x234384Adcbcbaf68145A42f13b0E666444961C0e](https://explorer.arc.io/address/0x234384Adcbcbaf68145A42f13b0E666444961C0e).

Mainnet smoke: [Smoke: Pay now 0.1 USDC signed checkout](https://explorer.arc.io/tx/0xa37dd595cf0f8e4ed74878f29ee88a8c5d68d640db3173ffec1449469c6ec0fe).
<!-- /MAINNET-ADDRESSES -->

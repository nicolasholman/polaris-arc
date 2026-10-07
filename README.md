# Polaris on Arc

**Stripe for every app on Arc.** One payment link to get paid now, in four
instalments on an on-chain credit line, or every month, in USDC. Buyers sign
up with Face ID, pay from any chain with CCTP, send dollars or euros by link,
and never buy gas: Arc's gas is USDC, and Polaris pays it.

- **The Polaris app** (buyers and senders): open a link, create an account
  with a passkey, and pay in USDC. Pay in full, Pay in 4 against a credit line
  (10% APR, the merchant paid in full up front), or subscribe; add money from
  Ethereum, Base, Arbitrum, Avalanche, OP or Polygon with **CCTP V2**; send
  **USDC or EURC** by link; split a bill. Every action is a signature.
- **Polaris for Business** (merchants and platforms): payment links, a checkout
  API and SDK (`polarispay-sdk`), a dashboard, signed webhooks, payouts. Every
  checkout lands on Arc with the merchant's order reference in an **Arc Memo**.
- **The credit engine**: a USDC credit pool, credit scores, Boost (USDC
  collateral), and the **Polaris keeper**, which collects instalments on time
  and writes credit reviews on chain. A **credit guard** pauses new Pay in 4
  plans the moment the pool runs short, read live from the pool.

Ported from the Monad version of Polaris (AUSD, Mera passkeys, Chainlink CRE,
Envio) to Arc. What changed and why is in [What it uses Arc for](#what-it-uses-arc-for).

---

## What it uses Arc for

| Arc / Circle primitive | Where | How |
|---|---|---|
| **USDC as the settlement asset and the gas token** | every contract; the relayer and the keeper | The pool, payments, plans and payouts are USDC at `0x3600…0000` (6 decimals). The relayer and keeper hold only USDC: there is no second token to buy, price or top up. Buyers and merchants never hold gas at all: every action is an ERC-2612 or ERC-3009 signature on USDC. |
| **Sub-second deterministic finality** | checkout, send links, the keeper | "Paid" shows before the popup closes: the relayer waits for the receipt (final in under a second) and the merchant's webhook goes out in the same second. No confirmation counts anywhere. |
| **CCTP V2: pay from any chain** | app *Add money from another chain*; `POST /api/public/cctp/mint` ([`apps/business/src/server/cctp.ts`](apps/business/src/server/cctp.ts)) | The buyer burns USDC on the source chain with `TokenMessengerV2.depositForBurn(…, 26, theirPolarisAccount, …)`; Polaris reads Circle's attestation from Iris and calls `MessageTransmitterV2.receiveMessage` on Arc, paying the gas. The buyer needs nothing on Arc. |
| **EURC** | `PolarisSend` deployed on EURC; app *Send in euros* | Cross-border send links in euros: EURC's ERC-3009 authorization is escrowed by a second `PolarisSend` and claimed by the link key, exactly like dollars. |
| **Transaction memos** | relayer ([`chain/circle.ts`](apps/business/src/server/chain/circle.ts), [`relayer/submit.ts`](apps/business/src/server/relayer/submit.ts)) | Every `PolarisCheckout.pay` / `openPlan` / `subscribe` goes through Arc's `Memo` contract with `memoId` = the order key and `memo` = `polaris:pay:<orderId>`: merchants reconcile on chain from the `Memo` event; the relayer stays `msg.sender` (Arc's CallFrom). |
| **Gas paid in USDC with a 20 gwei floor** | `lib/tx.js`, the relayer, the keeper | Every transaction prices `maxFeePerGas` at or above Arc's floor. |
| **Blockscout explorer and API** | contract verification; underwriting | Contracts are verified on `explorer.testnet.arc.io`; a buyer's Arc account age and history come from its keyless API. |
| **Envio HyperSync on Arc** | `packages/indexer` (optional) | The indexer targets `arc-testnet` / `arc`; the business server's own chain sync is the default. |

Not used, deliberately: **USYC** (yield on idle pool cash) needs an
allowlisted institutional account and a $100,000 minimum, so the pool keeps
USDC; **StableFX** needs a Circle FX account; **Circle Modular Wallets** are
ERC-4337 smart accounts, and Arc's Memo contract and Polaris's
signature-based flows need the buyer to be an EOA (see below). The Circle
contracts' addresses are all in [`lib/networks.js`](packages/contracts/lib/networks.js)
and in every deployment record.

### Passkeys on Arc

The Monad version created accounts with Mera. Mera (`@category-labs/mera`)
is a chain-agnostic library: WebAuthn's PRF extension gives 32 bytes, which
derive an ordinary secp256k1 key in the browser, never stored or sent. That
EOA works on Arc unchanged, so the app keeps it: Face ID is the account, the
relayer pays the gas. We evaluated **Circle Modular Wallets** (passkey-backed
MSCA, supported on Arc testnet): they need a Circle client key and route
everything through an ERC-4337 bundler, Arc's `Memo` refuses smart-account
callers, and every Polaris flow (ERC-3009 `receiveWithAuthorization`,
permits, the contracts' own EIP-712 intents) is built on EOA signatures. A
Privy email login remains as the embedded-wallet fallback.

---

## How it fits together

```text
  Buyer's phone (PWA)                Merchant                       Any app / shop
  ┌──────────────────────┐   ┌──────────────────────────┐   ┌──────────────────────┐
  │ Polaris app           │   │ Polaris for Business      │◀──│ polarispay-sdk       │
  │ Face ID → PRF → EOA   │──▶│ API · dashboard · webhooks│   │ (Halcyon demo shop)  │
  │ signatures only       │   │ relayer (USDC gas)        │   └──────────────────────┘
  │ CCTP burn on Base/…   │   │ CCTP mint · Arc Memo      │
  └──────────────────────┘   └─────────────┬──────────────┘
                                            │ transactions, final < 1 s
  ┌──────────────────────────────── Arc (testnet 5042002 / mainnet 5042) ─────────────┐
  │ PolarisCheckout · PolarisPayments · PolarisLoanEngine (USDC pool) · ScoreManager  │
  │ CollateralVault · MerchantRegistry · PolarisSend (USDC, EURC) · PolarisSplit      │
  │ CreditGuard · CollectionsReceiver · UnderwritingReceiver · BatchSettlement        │
  │ Circle: USDC · EURC · MessageTransmitterV2 · Memo                                  │
  └───────────────▲──────────────────────────────────────────────────────────────────┘
                  │ submitReport (keeper EOA, USDC gas)
  ┌───────────────┴────────────────────┐
  │ Polaris keeper (services/keeper)    │  collections every minute + on Reauthorized;
  │                                     │  credit reviews from Arc + linked-wallet history
  └─────────────────────────────────────┘
```

| Path | What |
|---|---|
| [`packages/contracts`](packages/contracts) | Solidity (Hardhat), 540 tests, the Arc deploy/verify/check scripts, `deployments/arc-*.json` |
| [`services/keeper`](services/keeper) | the keeper: collections and credit reviews |
| [`apps/business`](apps/business) | Polaris for Business: dashboard, API, relayer, webhooks, CCTP mint, Memo |
| [`apps/app`](apps/app) | the buyer app (Next.js PWA): passkeys, checkout, CCTP add money, send USD/EUR, split |
| [`apps/shop`](apps/shop) | Halcyon, the demo storefront on `polarispay-sdk` |
| [`apps/landing`](apps/landing) | the marketing site |
| [`packages/sdk`](packages/sdk) | `polarispay-sdk` (sessions, webhooks, direct pay) |
| [`packages/underwriting`](packages/underwriting) | evidence → ScoreManager facts (Arc account via RPC + Blockscout; linked wallet via public RPCs, Etherscan/Nansen/Zerion optional) |
| [`packages/indexer`](packages/indexer) | Envio HyperIndex on Arc (optional) |
| `packages/{db,ui,brand,fx,receipts}` | storage, design system, FX display rates, sealed receipts |

---

## Addresses

Arc testnet (chain `5042002`, [explorer](https://explorer.testnet.arc.io)): see
[`packages/contracts/deployments/arc-testnet.json`](packages/contracts/deployments/arc-testnet.json)
for every Polaris contract, the deploy and end-to-end transaction hashes, and
the verification results. Arc mainnet: `deployments/arc-mainnet.json` once
deployed ([MAINNET.md](MAINNET.md)).

Circle on Arc (testnet / mainnet): USDC `0x3600000000000000000000000000000000000000`;
EURC `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` / `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1`;
TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` / `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`;
MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` / `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`;
Memo `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` (both).

---

## Run it

Node 22.6+ and pnpm 10.

```bash
pnpm install
pnpm contracts:test          # 540 contract tests
pnpm e2e:local               # the backend end to end on a local node (14 checks)
DEMO_FAST_PLANS=1 pnpm demo:local   # everything, locally, in your browser
```

`pnpm demo:local` ([`scripts/demo-local.mjs`](scripts/demo-local.mjs)) starts
a Hardhat node (a block a second), deploys with the Arc deploy script in
local mode (MockUSDC and MockEURC stand in for Circle's tokens, with the same
EIP-712 domains), and runs Polaris for Business (:3100), the keeper (:2000),
the app (:3000), Halcyon the demo shop (:3600) and a faucet (:3650). Open the
shop, add something to the bag, check out with Polaris. `pnpm demo:e2e`
(Playwright, `PLAYWRIGHT_MODULE=<path>`) drives it headless.

### On Arc testnet

```bash
# 1. deploy (the deployer key stays in its own file)
cd packages/contracts
set -a; . "../../../.deployer/deployer.env"; set +a
POLARIS_KEEPER_ADDRESS=0x… POLARIS_RELAYER_ADDRESS=0x… POLARIS_FAST_PLANS=1 pnpm deploy:testnet
pnpm verify:testnet && pnpm check:testnet

# 2. the end to end on Arc testnet: real USDC, real transactions
cd ../.. && pnpm e2e:testnet
```

`pnpm e2e:testnet` ([`scripts/e2e-testnet.mjs`](scripts/e2e-testnet.mjs))
runs the business server and the keeper against the testnet record, funds a
fresh buyer with a few USDC, and checks on chain: Pay now through Arc's Memo,
Boost, Pay in 4, the keeper collecting instalment 1, and a euro link. It
writes every hash into the deployment record.

To run the apps against testnet: `apps/business/.env.example`,
`apps/app/.env.example`, `services/keeper/.env.example` and
`apps/shop/.env.example` document every variable; the root
[`.env.example`](.env.example) lists the runtime keys.

### Tests

```bash
pnpm --filter @polarispay/contracts test     # 540
pnpm --filter @polaris/business test         # 300
pnpm --filter @polaris/app test              # 84
pnpm --filter @polaris/keeper test
pnpm --filter polarispay-sdk test
pnpm --filter @polarispay/underwriting test
```

## Deploy to mainnet

One switch: `NETWORK=mainnet` (`pnpm deploy:mainnet`, with
`POLARIS_CONFIRM_MAINNET=yes`). Every app picks the chain from the record and
`NEXT_PUBLIC_CHAIN_ID`. Exact commands, the USDC it costs, the environment for
Vercel/Railway and the services to run: [MAINNET.md](MAINNET.md).

## Security notes

- Owner powers are minimal and listed per contract in
  [`packages/contracts/README.md`](packages/contracts/README.md). Collections
  are permissionless; the keeper can only write facts (scored on chain, capped
  at a $1,000 line, at most once per wallet) and collection records.
- Caps for mainnet: $10,000 per send link, $10,000 of Boost per account,
  $1,000 opening credit lines, per-merchant order caps, and a credit guard on
  the pool.
- The relayer refuses any call off its allow-list (the same list its Privy
  policy is built from), never sends native value, and caps gas and fees.

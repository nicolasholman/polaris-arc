# Polaris on Arc

**Stripe for every app on Arc.** One payment link to get paid now, in four
instalments on an on-chain credit line, or every month, in USDC. Buyers sign
up with Face ID, pay from any chain (Circle Gateway, CCTP V2, Chainlink CCIP),
send dollars or euros by link, and never buy gas: Arc's gas is USDC, and
Polaris pays it.

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
Envio) to Arc. What changed and why is in the [Arc stack](#arc-stack).

---

## Arc stack

Every piece below runs in Polaris, not just in a contract. "Verified" says
how far it was exercised; nothing is claimed beyond that. The public testnet
deploy is waiting on deployer funds, so live-network items are marked as
fork or user-run where that's the honest limit.

| Piece | What it does in Polaris | Contract / file | How verified |
|---|---|---|---|
| **USDC gas + sub-second finality** | One token for everything: the pool, payments, plans, payouts and every fee. The relayer and keeper hold only USDC, buyers hold no gas at all (every action is an ERC-2612/3009 signature), and "Paid" shows before the sheet closes. The app tells buyers "You only ever hold USDC". | all contracts; [`lib/tx.js`](packages/contracts/lib/tx.js) (20 gwei floor); [`relayer/submit.ts`](apps/business/src/server/relayer/submit.ts) | 544 Hardhat tests; Arc-fork deploy (27.5M gas, 0.58 USDC, 17 contracts) and testnet end to end 10/10 on the fork |
| **Circle Gateway (unified USDC balance)** | Deposit USDC once on Base, Ethereum, Arbitrum, Avalanche, OP, Polygon or Arc; pay any Polaris link on Arc with one signature (EIP-712 burn intent). Circle attests in about a second, the relayer calls `GatewayMinter.gatewayMint`, the checkout carries on. | [`server/gateway.ts`](apps/business/src/server/gateway.ts), `/api/public/gateway{,/intent,/mint}`; app [`gateway-sheet.tsx`](apps/app/src/components/gateway-sheet.tsx) | Unit tests (intent built and checked field by field, signature recovery); **live against Circle's testnet Gateway API** (`GATEWAY_LIVE=1`): a correct signature is refused only for the empty balance, a tampered one for the signature. Spending a real balance needs testnet USDC deposited (user-run) |
| **CCTP V2: pay from any chain** | *Add money from another chain*: burn on the source chain with `depositForBurn(…, 26, theirPolarisAccount)`, Polaris reads Iris and calls `receiveMessage` on Arc. | [`server/cctp.ts`](apps/business/src/server/cctp.ts), `/api/public/cctp/mint`; app [`cross-chain-deposit.tsx`](apps/app/src/components/cross-chain-deposit.tsx) | Business tests; the burn call is pure and tested. A real burn → attestation → mint needs source-chain testnet USDC (user-run) |
| **CCTP V2 hooks** | Pay an order in **one source-chain transaction**: `depositForBurnWithHook` with mint recipient and destination caller = `PolarisCctpHookReceiver` and hookData = (merchant, orderId, amount, refundTo). On Arc the relayer's `relay(message, attestation)` receives the mint and pays the order in the same call; anything unpayable goes back to the buyer on Arc. | [`PolarisCctpHookReceiver.sol`](packages/contracts/ccip/src/PolarisCctpHookReceiver.sol); `server/cctp.ts` | 5 Foundry tests on CCTP V2's exact byte layout (pay + excess refund, already-paid refund, fast-transfer fee shortfall, wrong domain/caller/recipient, starved relay) |
| **Chainlink CCIP** | *Pay from Base / Ethereum in one transaction*: `PolarisCCIPSender` burns with CCTP (the dollars) and sends the order or a Pay in 4 instalment over CCIP (the instruction) to `PolarisCCIPReceiver` on Arc. Fees in the source chain's native coin (`feeToken = address(0)`). The receiver allowlists (source selector, sender), never reverts on business logic (failed messages are stored for `retryFailed`), and settles once both halves have arrived, in either order; the keeper settles intents whose mint landed late. | [`ccip/src`](packages/contracts/ccip/src); keeper [`ccip.ts`](services/keeper/src/ccip.ts); app [`ccip-sheet.tsx`](apps/app/src/components/ccip-sheet.tsx); [`scripts/ccip-send.mjs`](scripts/ccip-send.mjs) (user-run, testnet only) | 10 **Chainlink Local** tests (CCIPLocalSimulator); 3 fork tests against Chainlink's real Arc testnet router (lanes to Base/Ethereum Sepolia, native-USDC fees, onlyRouter); **Arc-fork rehearsal**: message delivered before the dollars, keeper settles → `CrossChainPayment` ([`ccip-fork-demo.mjs`](scripts/ccip-fork-demo.mjs), hashes in `arc-fork-rehearsal.json`). Live sends: user-run |
| **Chainlink Data Feeds** | `CreditGuard` reads USDC / USD on every Pay in 4 decision on Arc mainnet: below $0.98 (`REASON_DEPEG`) or older than 26 h (`REASON_STALE_PRICE`) pauses new plans. EURC / USD and EUR / USD price euro links in the app and `/api/public/network` (display only). | [`CreditGuard.sol`](packages/contracts/contracts/CreditGuard.sol); [`server/rates.ts`](apps/business/src/server/rates.ts); app [`eurc-rate.tsx`](apps/app/src/components/eurc-rate.tsx) | 4 Hardhat peg tests (mock feed); 2 fork tests reading the **real Arc mainnet feeds through CreditGuard**; live reads from Arc mainnet. Arc testnet has no feeds, so the check is off there |
| **EURC / StableFX** | Send euros by link (a second `PolarisSend` on EURC, ERC-3009 escrow); EURC balances shown with the Chainlink EURC / USD rate. StableFX's FxEscrow is in the config, unused: its RFQ trading needs a Circle FX account. | `PolarisSendEURC`; app *Send in euros* | Hardhat tests; EURC link on the Arc fork e2e |
| **USYC** | Idle credit-pool cash above the floor (twice CreditGuard's minimum) is parked in USYC through Circle's Teller and brought back when Pay in 4 needs it. USYC is permissioned: the pool owner's address must be allowlisted by Circle (testnet: a support ticket). | [`scripts/usyc-treasury.js`](packages/contracts/scripts/usyc-treasury.js) (`status` / `park` / `unpark`) | **Arc-fork round trip against the real Teller**: 490 USDC → 430.000612 USYC → 489.995799 USDC back in the pool (allowlist granted on the fork only). Not run on testnet until the owner is allowlisted |
| **Arc Memo** | Every checkout (`pay` / `openPlan` / `subscribe`) is wrapped in Arc's Memo contract: `memoId` = order key, `memo` = `polaris:pay:<orderId>`, so merchants reconcile on chain. | [`chain/circle.ts`](apps/business/src/server/chain/circle.ts), `relayer/submit.ts` | Memo event verified on the Arc-fork e2e |
| **ERC-8004** | Not used: Polaris's keeper is a single operator key the contracts trust by address; there is no third-party agent or service provider to give an identity or reputation. | n/a | n/a |
| **Blockscout, Envio** | Contract verification; a buyer's Arc history for underwriting; an optional HyperIndex indexer on `arc-testnet` / `arc`. | `scripts/verify.js`, `packages/underwriting`, `packages/indexer` | Underwriting tests; indexer codegen (Envio itself not run) |

**Circle Modular Wallets** were evaluated and not used: they are ERC-4337
smart accounts, while Arc's Memo contract and every Polaris flow need the
buyer to be an EOA (see below). Every Circle and Chainlink address is in
[`lib/networks.js`](packages/contracts/lib/networks.js) and copied into each
deployment record.

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
  │ Gateway · CCTP · CCIP │   │ Gateway/CCTP mint · Memo  │
  └──────────────────────┘   └─────────────┬──────────────┘
                                            │ transactions, final < 1 s
  ┌──────────────────────────────── Arc (testnet 5042002 / mainnet 5042) ─────────────┐
  │ PolarisCheckout · PolarisPayments · PolarisLoanEngine (USDC pool) · ScoreManager  │
  │ CollateralVault · MerchantRegistry · PolarisSend (USDC, EURC) · PolarisSplit      │
  │ CreditGuard · CollectionsReceiver · UnderwritingReceiver · BatchSettlement        │
  │ PolarisCCIPReceiver · PolarisCctpHookReceiver                                      │
  │ Circle: USDC · EURC · MessageTransmitterV2 · GatewayMinter · Memo · USYC Teller    │
  │ Chainlink: CCIP router · USDC/USD, EURC/USD, EUR/USD Data Feeds (mainnet)          │
  └───────────────▲──────────────────────────────────────────────────────────────────┘
                  │ submitReport (keeper EOA, USDC gas)
  ┌───────────────┴────────────────────┐
  │ Polaris keeper (services/keeper)    │  collections every minute + on Reauthorized;
  │                                     │  credit reviews; settles late CCIP intents
  └─────────────────────────────────────┘
```

| Path | What |
|---|---|
| [`packages/contracts`](packages/contracts) | Solidity (Hardhat, 544 tests) and the CCIP / CCTP-hook layer (`ccip/`, Foundry with Chainlink Local), the Arc deploy/verify/check/USYC scripts, `deployments/arc-*.json` |
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
Memo `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` (both);
GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` / `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`;
GatewayMinter `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` / `0x2222222d7164433c4C09B0b0D809a9b52C04C205`;
USYC Teller `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` / `0x51A8CE47dC08ba5CD19c7aa84EA6fD6664f60f9b`.

Chainlink on Arc: CCIP router `0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8` (testnet, selector
`3034092155422581607`) / `0xB79791184973589c38e114D43Eb8E4588C283A18` (mainnet, `6370580034781731079`);
Data Feeds on mainnet: USDC / USD `0x84EA90AC252Dc437031461836DB5164219147905`,
EURC / USD `0x361b95c10b76Ca3f35C686d423e43A951755Bf23`, EUR / USD `0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D`.

---

## Run it

Node 22.6+ and pnpm 10.

```bash
pnpm install
pnpm contracts:test          # 544 contract tests (Hardhat)
pnpm --filter @polarispay/contracts test:ccip   # CCIP + CCTP hook layer (Foundry, Chainlink Local)
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

### Cross-chain, rehearsed on an Arc testnet fork

```bash
ARC_ANVIL=/path/to/arc-anvil sh scripts/arc-fork.sh          # fork Arc testnet, deploy, fund keeper/relayer
node scripts/ccip-fork-demo.mjs                               # CCIP message lands before the dollars
KEEPER_RPC_URL=http://127.0.0.1:18745 POLARIS_DEPLOYMENT_FILE=.fork/arc-fork.json pnpm --filter @polaris/keeper once
cd packages/contracts && POLARIS_USYC=park POLARIS_USYC_FORK_ALLOWLIST=1 \
  ARC_TESTNET_RPC_URL=http://127.0.0.1:18745 POLARIS_DEPLOYMENT_FILE=../../.fork/arc-fork.json \
  npx hardhat run scripts/usyc-treasury.js --network arcTestnet   # idle pool cash into USYC and back (unpark)
```

Live cross-chain sends are user-run and testnet only:
`PAYER_PRIVATE_KEY=0x… node scripts/ccip-send.mjs pay --from base-sepolia …`
after deploying a sender (`pnpm --filter @polarispay/contracts ccip:deploy-sender:base-sepolia`)
and allowlisting it on Arc (`ccip:allow-senders:testnet`).

To run the apps against testnet: `apps/business/.env.example`,
`apps/app/.env.example`, `services/keeper/.env.example` and
`apps/shop/.env.example` document every variable; the root
[`.env.example`](.env.example) lists the runtime keys.

### Tests

```bash
pnpm --filter @polarispay/contracts test     # 544 (Hardhat)
pnpm --filter @polarispay/contracts test:ccip      # Foundry: Chainlink Local CCIP + CCTP hooks
ARC_FORK_TESTS=1 pnpm --filter @polarispay/contracts test:ccip:fork   # real Arc testnet router + Arc mainnet feeds
pnpm --filter @polaris/business test         # 306 (+ GATEWAY_LIVE=1 for Circle's testnet Gateway API)
pnpm --filter @polaris/app test              # 106
pnpm --filter @polaris/keeper test           # 10
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

# Polaris on Arc

Live: https://app-production-5010.up.railway.app (Arc testnet)


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
Envio) to Arc; the Envio indexer is not hosted for this build. What changed and why is in the [Arc stack](#arc-stack).

---

## Arc stack

Every piece below runs in Polaris, not just in a contract. The last column
says exactly how far each was exercised, in three words: **Live** (real
transactions on Arc testnet, hashes in [docs/E2E-TESTNET.md](docs/E2E-TESTNET.md)),
**Fork** (a local fork of Arc testnet or Chainlink Local, not the public
network) and **Not run** (built and unit-tested, never executed end to end).
All 14 Polaris contracts are deployed on Arc testnet.

| Piece | What it does in Polaris | Contract / file | Status |
|---|---|---|---|
| **USDC gas + sub-second finality** | One token for everything: the pool, payments, plans, payouts and every fee. The relayer and keeper hold only USDC, buyers hold no gas at all (every action is an ERC-2612/3009 signature). | all contracts; [`lib/tx.js`](packages/contracts/lib/tx.js) (20 gwei floor); [`relayer/submit.ts`](apps/business/src/server/relayer/submit.ts) | **Live**: the testnet end to end ran with a buyer that sent no transaction. 544 Hardhat tests. The "sub-second" figure is Arc's own claim; blocks were about 0.5 s apart on the explorer |
| **Memo** | Every checkout (`pay` / `openPlan` / `subscribe`) is wrapped in Arc's Memo contract: `memoId` = order key, `memo` = `polaris:pay:<orderId>`, so merchants reconcile on chain. | [`chain/circle.ts`](apps/business/src/server/chain/circle.ts), `relayer/submit.ts` | **Live**: the payment-link transaction is a Memo call carrying its order key |
| **Pay in 4 / credit pool / Boost / keeper** | A USDC credit pool, collateral Boost, instalments collected by the keeper through `CollectionsReceiver`, a credit guard that pauses new plans when free cash falls under its floor. | `PolarisCheckout`, `PolarisLoanEngine`, `CollateralVault`, `CreditGuard`, [`services/keeper`](services/keeper) | **Live**: Boost + a plan opened on testnet; the first instalment is due one hour later and is collected in the second phase (`pnpm e2e:testnet:collect`), see E2E-TESTNET.md for whether it ran |
| **Circle Gateway (unified USDC balance)** | Deposit USDC once on another chain; pay any Polaris link on Arc with one signature (EIP-712 burn intent). The relayer calls `GatewayMinter.gatewayMint`. | [`server/gateway.ts`](apps/business/src/server/gateway.ts), `/api/public/gateway{,/intent,/mint}`; app [`gateway-sheet.tsx`](apps/app/src/components/gateway-sheet.tsx) | **Not run** end to end: unit tests (intent field by field, signature recovery) and a check against Circle's testnet Gateway API (`GATEWAY_LIVE=1`: a correct signature is refused only for the empty balance); no Gateway balance was deposited or minted |
| **CCTP V2: add money from another chain** | Burn on the source chain with `depositForBurn(…, 26, theirPolarisAccount)`; Polaris reads Iris and calls `receiveMessage` on Arc. | [`server/cctp.ts`](apps/business/src/server/cctp.ts), `/api/public/cctp/mint`; app [`cross-chain-deposit.tsx`](apps/app/src/components/cross-chain-deposit.tsx) | **Not run**: tested at the unit level; a real burn, attestation and mint needs source-chain testnet USDC (user-run) |
| **CCTP V2 hooks** | Pay an order in **one source-chain transaction**: `depositForBurnWithHook` to `PolarisCctpHookReceiver`; on Arc `relay(message, attestation)` receives the mint and pays the order, refunding anything unpayable. | [`PolarisCctpHookReceiver.sol`](packages/contracts/ccip/src/PolarisCctpHookReceiver.sol); `server/cctp.ts` | Receiver **deployed on testnet**; the flow is **Fork** / unit only: 5 Foundry tests on CCTP V2's byte layout. No live burn |
| **Chainlink CCIP** | *Pay from Base / Ethereum in one transaction*: `PolarisCCIPSender` burns with CCTP and sends the instruction over CCIP to `PolarisCCIPReceiver` on Arc (allowlist, stored failures, settles once both halves arrive). | [`ccip/src`](packages/contracts/ccip/src); keeper [`ccip.ts`](services/keeper/src/ccip.ts); app [`ccip-sheet.tsx`](apps/app/src/components/ccip-sheet.tsx); [`scripts/ccip-send.mjs`](scripts/ccip-send.mjs) | Receiver **deployed on testnet**, no sender deployed, no allowlisted lane. Flow is **Fork**: 10 Chainlink Local tests, 3 tests against Chainlink's real Arc testnet router on a fork, and an Arc-fork rehearsal ([`ccip-fork-demo.mjs`](scripts/ccip-fork-demo.mjs)). A live cross-chain send is **Not run** |
| **Chainlink Data Feeds** | `CreditGuard` can read USDC / USD on every Pay in 4 decision: below $0.98 or older than 26 h pauses new plans. EURC / USD and EUR / USD price euro links in the app (display only). | [`CreditGuard.sol`](packages/contracts/contracts/CreditGuard.sol); [`server/rates.ts`](apps/business/src/server/rates.ts); app [`eurc-rate.tsx`](apps/app/src/components/eurc-rate.tsx) | **Mainnet only.** Arc testnet has no feeds: the testnet CreditGuard has `priceFeed = null` and checks pool cash and bad debt only. The peg check is **Fork**-tested against the real Arc mainnet feeds (2 fork tests, 4 mock-feed tests); display rates are live reads from Arc mainnet |
| **EURC send links** | Send euros by link (a second `PolarisSend` on EURC, ERC-3009 escrow). StableFX's FxEscrow is in the config, unused. | `PolarisSendEURC`; app *Send in euros* | Contract **deployed on testnet**; the live link is **Not run** (the deployer holds no testnet EURC; faucet.circle.com). Run on the Arc **Fork** |
| **USDC send links** | Send dollars by link: a one-time key, claimable by anyone who opens the link. | `PolarisSend` | **Live**: created and claimed on testnet |
| **USYC** | Idle credit-pool cash above the floor is parked in USYC through Circle's Teller and brought back when needed. USYC is permissioned: the pool owner must be allowlisted by Circle. | [`scripts/usyc-treasury.js`](packages/contracts/scripts/usyc-treasury.js) | **Fork** only: 490 USDC → 430.000612 USYC → 489.995799 USDC on an Arc fork with the allowlist granted on the fork. **Not run** on testnet or mainnet |
| **ERC-8004** | Not used: Polaris's keeper is a single operator key the contracts trust by address. | n/a | n/a |
| **Blockscout, underwriting** | Contract verification; a buyer's Arc history for credit reviews. | `scripts/verify.js`, `packages/underwriting` | **Live**: 13 of 15 contract records verified on explorer.testnet.arc.io (`pnpm --filter @polarispay/contracts verify:blockscout:testnet`); the two Foundry-built receivers are not. Underwriting: unit tests only |
| **Envio indexer** | An optional HyperIndex indexer config for `arc-testnet` / `arc`. | `packages/indexer` | **Not run / not hosted.** Nothing in Polaris depends on it: the business server reads Arc itself (chain sync over RPC) and its Overview says "not connected" when no indexer URL is set |

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
fresh buyer with a few USDC, and checks on chain: a USDC send link created and
claimed, a merchant payment link paid through Arc's Memo, a subscription,
Boost and Pay in 4, and (if the deployer holds EURC) a euro link. The keeper
collects the plan's first instalment an hour later (`pnpm e2e:testnet:collect`).
It writes every hash into the deployment record; the run that is live today is
written up, with explorer links, in [docs/E2E-TESTNET.md](docs/E2E-TESTNET.md).
The Envio indexer is not used: the business server reads Arc itself.

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
pnpm --filter @polaris/business test         # 310 (+ GATEWAY_LIVE=1 for Circle's testnet Gateway API)
pnpm --filter @polaris/app test              # 119
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

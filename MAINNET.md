# Deploying Polaris to Arc mainnet

Mainnet is the same code and the same script as testnet, switched by
`NETWORK=mainnet`. Nothing here has been broadcast to mainnet yet.

## 1. Keys and accounts

| Account | What it does | Funding (USDC on Arc, which is also gas) |
|---|---|---|
| Deployer | deploys and owns every contract | ~2 USDC for gas, plus the pool seed |
| Keeper | the only address the receivers accept (`submitReport`) | 5 USDC (a collections report costs ~0.01 USDC) |
| Relayer | carries every buyer and merchant signature | 10 USDC to start; top up as volume grows (a relayed checkout costs ~0.01 USDC) |
| Treasury | receives protocol fees | none |

Use a **Privy server wallet** for the relayer on mainnet (`RELAYER_MODE=privy`;
`RELAYER_MODE=local` refuses chain 5042). Its policy is generated from the same
allow-list the server enforces (`pnpm --filter @polaris/business privy:setup-relayer`),
including Arc's Memo (target restricted to PolarisCheckout) and CCTP's
`receiveMessage`. The keeper is a plain EOA kept on the keeper host.

## 2. Deploy

```bash
cd packages/contracts
set -a; . "/secure/path/deployer.env"; set +a      # DEPLOYER_PRIVATE_KEY, never in the repo
NETWORK=mainnet POLARIS_CONFIRM_MAINNET=yes \
POLARIS_KEEPER_ADDRESS=0xKEEPER \
POLARIS_RELAYER_ADDRESS=0xRELAYER \
POLARIS_TREASURY=0xTREASURY \
POLARIS_POOL_SEED_USDC=0 \
  pnpm deploy:mainnet
pnpm verify:mainnet      # Blockscout at explorer.arc.io
pnpm check:mainnet       # read-only: every role, cap and the guard
POLARIS_CONFIRM_MAINNET=yes POLARIS_FUND_USDC=1000 pnpm fund-pool:mainnet   # when ready to lend
```

This writes `packages/contracts/deployments/arc-mainnet.json` (commit it: every
app reads it). Then regenerate what reads addresses at build time:

```bash
pnpm --filter polarispay-sdk gen:deployments      # SDK constants (ARC)
node packages/indexer/scripts/generate.mjs --network mainnet   # if running the indexer
```

Mainnet defaults the script applies: CreditGuard reads Chainlink's USDC / USD
feed (`0x84EA…7905`; pause new plans below $0.98 or on an answer older than
26 h), PolarisCCIPReceiver on Chainlink's Arc router and PolarisCctpHookReceiver
on Circle's MessageTransmitterV2 are deployed, no pool seed unless asked, a $1,000
free-cash floor on the credit guard, 3-day grace, hourly minimum intervals,
the demo merchant capped at $1,000 per order. Caps built into the contracts:
$10,000 per send link, $10,000 locked per account (owner can raise to at most
$1M), $1,000 opening credit lines.

### Cross-chain senders (user-run, after the Arc deploy)

`PolarisCCIPSender` lives on each source chain and is ownerless; deploy it
with your own key, then allowlist it on the Arc receiver:

```bash
NETWORK=mainnet POLARIS_CONFIRM_MAINNET=yes npx hardhat run scripts/ccip-deploy-sender.js --network base
NETWORK=mainnet POLARIS_CONFIRM_MAINNET=yes npx hardhat run scripts/ccip-deploy-sender.js --network ethereum
NETWORK=mainnet POLARIS_CONFIRM_MAINNET=yes npx hardhat run scripts/ccip-allow-sender.js --network arcMainnet
```

Lanes (Chainlink CCIP directory): Base `15971525489660198786` → Arc
`6370580034781731079`, Ethereum `5009297550715157269` → Arc. Fees are paid in
the source chain's native coin. `scripts/ccip-send.mjs` refuses mainnet
sources by design; a mainnet payment goes through the app's CCIP sheet from
the buyer's own wallet.

### USYC (optional)

Ask Circle to allowlist the deployer (the pool owner) for USYC on Arc
mainnet (Teller `0x51A8…0f9b`, Entitlements `0xb69e…ca72`), then
`NETWORK=mainnet POLARIS_CONFIRM_MAINNET=yes POLARIS_USYC=status|park|unpark
npx hardhat run scripts/usyc-treasury.js --network arcMainnet`. `park` keeps
twice CreditGuard's free-cash floor in the pool.

## 3. Cost

Measured on the Arc-fork deploy with the same script: **27.5M gas** for the full
deploy and wiring (17 contracts including the CCIP and CCTP-hook receivers,
~20 configuration transactions), 0.58 USDC at the fork's fee. At Arc's
current fee (~25-30 gwei of USDC; the floor is 20 gwei) that is **about 0.7-0.8
USDC**. The testnet deploy's measured cost is in
`deployments/arc-testnet.json` (`gas.totalCostUsdc`). Budget:

| Item | USDC |
|---|---|
| Deploy + wiring | ~1 (2 to be safe) |
| Verification | 0 (Blockscout) |
| Keeper and relayer gas for a demo (tens of transactions) | ~1 |
| Pool liquidity for a short demo (e.g. three $50 Pay in 4 orders) | 150-200 |
| **Total for deploy + short demo** | **~5 for gas, plus whatever liquidity the pool should lend** |

## 4. Services and environment

| Service | Where | Notes |
|---|---|---|
| Polaris for Business | Vercel (`apps/business`) | HTTP API and merchant UI; existing Atlas via `POLARIS_DB_URL`, `POLARIS_MONGO_DB=arc_polaris_mainnet`; `POLARIS_WORKERS=0`, authenticated `/api/cron/tick` |
| Polaris keeper | Vercel scheduled function for testnet; on demand locally otherwise | `/api/cron/collections` runs a bounded pass, testnet only; daily schedule. `pnpm --filter @polaris/keeper once` for a prompt demo pass. Mainnet cron is not enabled. |
| Polaris app | Vercel | static + `/api/fx`; `NEXT_PUBLIC_*` at build time |
| Landing, demo shop | Vercel | `apps/landing` and `apps/shop`; shop uses existing Atlas (`MONGODB_URI`, `SHOP_MONGO_DB=arc_polaris_shop_mainnet`) or existing Redis, never function-local files |
| Envio indexer | Envio Cloud | optional (`ENVIO_API_TOKEN`); the business server's chain sync works without it |

**Polaris for Business** (full list in `apps/business/.env.example`):

```
POLARIS_DEPLOYMENT=arc-mainnet
POLARIS_RPC_URL=https://rpc.mainnet.arc.io
RELAYER_MODE=privy
PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_VERIFICATION_KEY
PRIVY_RELAYER_WALLET_ID / PRIVY_RELAYER_ADDRESS / PRIVY_RELAYER_AUTH_KEY
PRIVY_ADMIN_QUORUM_ID
REGISTRY_ACTIVATOR=privy (+ PRIVY_REGISTRY_*) or off
POLARIS_KEY_PEPPER, CRON_SECRET, POLARIS_TRUSTED_PROXIES=1
POLARIS_CHECKOUT_ORIGIN=https://<app>, POLARIS_PUBLIC_URL=https://<business>
KEEPER_UNDERWRITING_URL=https://<keeper>/underwrite (private network preferred)
POLARIS_KEEPER_CALLBACK_SECRET=<shared with the keeper>
NEXT_PUBLIC_CHAIN_ID=5042, NEXT_PUBLIC_PRIVY_APP_ID, NEXT_PUBLIC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
```

**Keeper** (`services/keeper/.env.example`):

```
POLARIS_DEPLOYMENT=arc-mainnet
KEEPER_RPC_URL=https://rpc.mainnet.arc.io
POLARIS_KEEPER_PRIVATE_KEY=<keeper key>
POLARIS_API_URL=https://<business>
POLARIS_KEEPER_CALLBACK_SECRET=<shared>
KEEPER_HOST=0.0.0.0 (behind a private network or the platform's internal DNS)
UNDERWRITING_ACCOUNT_CHAIN_ID=5042
NANSEN_API_KEY / ZERION_API_KEY / ETHERSCAN_API_KEY (optional, for linked-wallet history)
```

**App** (`apps/app/.env.example`):

```
NEXT_PUBLIC_POLARIS_API_URL=https://<business>
NEXT_PUBLIC_CHAIN_ID=5042
NEXT_PUBLIC_RP_ID=<the app's domain>  (a passkey is tied to it forever)
NEXT_PUBLIC_PRIVY_APP_ID (optional, email login)
```

Circle Gateway switches to `gateway-api.circle.com` and the mainnet
GatewayWallet / GatewayMinter from the record; `ARC_MAINNET_RPC_URL` (default
`https://rpc.mainnet.arc.io`) is where the Chainlink EURC / USD and USDC / USD
rates are read for display on mainnet. Testnet hosting leaves these rates unavailable unless a local Arc mainnet fork is configured.

The app's CCTP sources switch to mainnet automatically (`/api/public/network`
serves Ethereum, Avalanche, OP, Arbitrum, Base and Polygon with Circle's
mainnet USDC and TokenMessengerV2) and the CCTP mint uses
`iris-api.circle.com`.

## 5. After deploying

1. `pnpm check:mainnet` passes; every contract shows as verified on explorer.arc.io.
2. `GET https://<business>/api/health/ready` is 200; the dashboard's Automation
   page shows the keeper running, its gas balance, and the credit guard.
3. Fund the pool when ready to lend; until then CreditGuard pauses Pay in 4
   (low cash) and Pay now, Subscribe and send links work.
4. Record the deploy and a first payment's hashes in the README.

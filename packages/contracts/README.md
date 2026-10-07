# @polarispay/contracts

The Polaris contract layer on **Arc**: one checkout for **Pay now**, **Pay in 4**
on a Polaris credit line, and **Subscribe**; the credit pool, loan engine and
credit scores behind it; send-by-link in **USDC and EURC**; split-the-bill
links; the **credit guard**; and the two receivers the **Polaris keeper** writes
to (collections, underwriting). Settled in Circle's USDC on Arc
(`0x3600…0000`, 6 decimals). Every user action is a signature a relayer
submits, and Arc's gas is USDC, so buyers, senders and merchants never hold
anything but dollars.

## Contracts

| Contract | What it does | Owner powers |
|---|---|---|
| `PolarisCheckout` | `pay` (ERC-3009), `openPlan` (PlanIntent + ERC-2612 permit), `subscribe`, `reauthorize` | pause, set the credit guard |
| `PolarisLoanEngine` | the credit pool: Pay in 4 loans at 10% APR, collection, early repayment by signature, liquidation against Boost collateral | fund / withdraw free liquidity (its own LP money), set treasury, originators, vault, registry |
| `PolarisPayments` | Pay now settlement (0.5% fee), subscription plans and renewals | fee (max 5%), treasury, operators |
| `ScoreManager` | credit scores: opening score from keeper-reported facts (capped at $1,000), on-time / late / default updates | writers, underwriters, `requireUnderwriting` |
| `CollateralVault` | Boost: lock USDC to raise a Pay in 4 line; withdraw by signature when nothing is owed | multiplier, seizers, **per-account cap** (default $10,000, max $1M) |
| `MerchantRegistry` | merchants register by their own EIP-712 signature; per-merchant Pay in 4 cap | activate, cap, operators |
| `PolarisSend` | send money by link: escrow of an ERC-3009 authorization, claimed by the link key's signature. Deployed twice: on **USDC** and on **EURC**. **$10,000 cap per link.** | none (ownerless) |
| `PolarisSplit` | split the bill: each friend pays their share straight to the organiser | none (ownerless, no custody) |
| `BatchSettlement` | batched merchant payouts | settlers |
| `CreditGuard` | pauses **new** Pay in 4 plans when the pool's free cash is below its floor or bad debt passes its share; reads the pool live, no reports | thresholds, force pause / resume (max 1 day), acknowledge bad debt |
| `CollectionsReceiver` | the keeper's collections report: collect, charge, liquidate (all permissionless on their targets) | rotate the keeper |
| `UnderwritingReceiver` | the keeper's underwriting report: facts in, `ScoreManager.underwrite`, one history per credit line | rotate the keeper |
| `MockUSDC` | local and unit-test stand-in for USDC/EURC on Arc: same domain ("USDC"/"EURC", "2"), permit, ERC-3009, no ERC-5267. **Never deployed to Arc.** | none |

### What changed from the Monad version

- AUSD → **USDC on Arc** (still 6 decimals: the pool math is unchanged; every
  `1e6` was rechecked). USDC on Arc has no `eip712Domain()`, so
  `lib/eip712.js readDomain` reads `name()`/`version()` and checks them
  against `DOMAIN_SEPARATOR()`; `MockUSDC` behaves the same way so the local
  stack signs exactly as Arc does.
- The Chainlink CRE layer (forwarder, workflow metadata, simulation
  transmitter) is gone. The receivers take `submitReport(bytes)` from **one
  keeper EOA** (`KeeperReceiver`), with the same report encodings.
- The CRE guardian (a USDC/USD peg attestation) is replaced by **CreditGuard**,
  which needs no attestation: USDC is Arc's unit of account, so the only
  risks to new credit are in the pool, and it reads them live on every
  `openPlan`.
- Mainnet caps: $10,000 per send link, $10,000 locked per account, Pay in 4
  opening lines capped at $1,000 (unchanged), per-merchant order caps.

## Commands

```bash
pnpm --filter @polarispay/contracts test          # 540 tests (Hardhat)
pnpm --filter @polarispay/contracts abi           # regenerate abi/ after a contract change
pnpm --filter @polarispay/contracts node:local    # a Hardhat node on :8600
pnpm --filter @polarispay/contracts deploy:local  # NETWORK=local: MockUSDC/MockEURC, $50,000 pool
pnpm --filter @polarispay/contracts check:local   # read-only: every role, cap and the guard
```

### Arc testnet and mainnet

One script for every network (`scripts/deploy.js`, `NETWORK=testnet|mainnet|local`).
It writes `deployments/arc-<network>.json`, which every app reads.

```bash
# from packages/contracts; the deployer key is never kept in this repo
set -a; . "../../../.deployer/deployer.env"; set +a
POLARIS_KEEPER_ADDRESS=0x… POLARIS_RELAYER_ADDRESS=0x… pnpm deploy:testnet
pnpm verify:testnet      # Blockscout (explorer.testnet.arc.io)
pnpm check:testnet       # read-only checks
```

Mainnet is the same with `deploy:mainnet` and `POLARIS_CONFIRM_MAINNET=yes`;
see [`MAINNET.md`](../../MAINNET.md).

Environment for `deploy.js`:

| Variable | Meaning |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | owner of every contract; source it from its own file in the command |
| `POLARIS_KEEPER_ADDRESS` | the keeper EOA (required; must not be the deployer) |
| `POLARIS_RELAYER_ADDRESS` | the relayer EOA: Payments and registry operator, BatchSettlement settler |
| `POLARIS_TREASURY` | protocol fees (default: the deployer) |
| `POLARIS_POOL_SEED_USDC` | USDC to fund the credit pool with (testnet 25, mainnet 0, local 50,000; never more than the deployer holds less 1 USDC for gas) |
| `POLARIS_GUARD_MIN_FREE_CASH_USDC` | CreditGuard's free-cash floor (testnet 5, mainnet 1,000) |
| `POLARIS_FAST_PLANS=1` | minute-long instalment intervals and a 15-minute grace (demos) |
| `POLARIS_DEMO_MERCHANT_KEY` | the demo merchant's key (default: a fresh one in `deployments/.keys/`, git-ignored) |
| `POLARIS_CONFIRM_MAINNET=yes` | required for `NETWORK=mainnet` |

Every transaction goes through `lib/tx.js`: an estimated gas limit plus 15%,
priced at or above Arc's 20 gwei floor. The record includes the total gas
used and its cost in USDC.

## Layout

- `contracts/` the contracts; `contracts/keeper/` the receivers; `contracts/test/` test doubles.
- `lib/` `deploy.js`, `networks.js` (Arc testnet/mainnet addresses: USDC, EURC, USYC, CCTP, Gateway, StableFX, Memo), `keeper.js` (report encodings, guard reasons), `eip712.js`, `tx.js`.
- `scripts/` `deploy.js`, `verify.js`, `check.js`, `fund-pool.js`, `export-abi.js`.
- `abi/` the ABIs every app imports (`@polarispay/contracts/abi`).
- `deployments/` `arc-testnet.json`, `arc-mainnet.json` (after a deploy).

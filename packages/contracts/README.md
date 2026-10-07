# @polarispay/contracts

The Polaris contract layer on Monad: one checkout for **Pay now**, **Pay in 4**
on a Polaris credit line, and **Subscribe**; the BNPL loan engine and credit
scores behind it; send-by-link; split-the-bill links; and the three **Chainlink CRE** receivers that
run collections, underwriting and the pool guardian (which can pause new Pay in
4 plans on an AUSD depeg or a pool shortfall). Settled in AUSD. Every user
action is a signature a relayer submits, so buyers, senders and merchants never
hold MON.

## One command

```bash
pnpm install
pnpm --filter @polarispay/contracts test        # the whole suite (Hardhat)
pnpm --filter @polarispay/contracts e2e:local   # node on :8600, deploy, nine flows end to end
```

`e2e:local` starts a Hardhat node on `127.0.0.1:8600`, deploys everything with
the same script as testnet (MockAUSD, a local forwarder and a local AUSD/USD
feed standing in for AUSD and Chainlink's), and runs: an underwriting report
opens a buyer's line; Pay now; Pay in 4 ($200 as 4 x $50.38, the merchant paid
in full), after which a Pay now authorization the buyer signed for the same
order is refused; a collections report collects instalment 1; the buyer pays
the rest early by signature; guardian attestations pause Pay in 4 on a depeg
(Pay now still works) and resume it; a second plan opens; the buyer's
allowance is lost, collection is skipped, the buyer re-signs through
`reauthorize` and the retry report collects at once; Subscribe; a collections
report charges the renewal; send by link; claim. It prints gas used against
each estimated limit and fails if any user sent a transaction or held MON.

The reports in this run are hand-built by the script (literal underwriting
facts, hand-picked collection actions, attestations from a local stand-in
price feed) and delivered through the mock forwarder by a stand-in key. No CRE workflow, DON or Nansen call runs here, so
it is evidence for the receivers and contracts only. The CRE evidence is the
workflows' own `e2e:local` (the real handlers against this stack) and
`cre workflow simulate` output.

## Deploy to Monad testnet

```bash
pnpm --filter @polarispay/contracts deployer       # creates DEPLOYER_PRIVATE_KEY in the root .env if missing; prints address + balance
# fund that address with ~3 MON from https://testnet.monad.xyz
pnpm --filter @polarispay/contracts deploy:monad   # deploys, wires every role, writes deployments/monad-testnet.json
```

Then, as needed:

| Command | When |
|---|---|
| `fund-pool:monad` | The credit pool is empty because the deployer held no AUSD (the Agora faucet is dry; `docs/research/ausd.md` 5.2). Send AUSD to the deployer, then run it. Or redeploy with `AUSD_MODE=mock`. |
| `RELAYER_ADDRESS=0x… grant-relayer:monad` | The Privy relayer wallet exists: gives it PolarisPayments and MerchantRegistry operator and BatchSettlement settler. |
| `ETHERSCAN_API_KEY=… verify:monad` | Verify every contract on Monadscan (Etherscan V2 API, `chainid` 10143 on every call; `lib/monadscan.js`), and the ones a redeploy replaced, each from the sources that built it: today's when they reproduce its code, else those of the commit the record names (`sourceCommit`), rebuilt from git and checked against the chain first (and that commit's too when today's differ only in comments and it gives the exact bytes, so the explorer shows the text deployed), cut down to the files it is built from (`lib/verify.js`). Constructor arguments are read from each creation transaction and checked against the record. Writes `deployments/monad-testnet.verification.json` (address, name, verified, explorer link, compiler) from what the explorer says. `VERIFY_DRY_RUN=1` checks all of them with no key and no submission; `VERIFY_ONLY=A,B` submits some. Done on 28 Sep 2026: 13 of 13 verified, every one an exact match. |
| `redeploy-guardian:monad` | Replace GuardianReceiver alone with today's code and point PolarisCheckout's credit guard at it (`lib/redeploy.js`); refuses unless the deployer owns PolarisCheckout, the receiver is not already today's code, `contracts/` is committed and the MON is there. Writes the record (with a `redeploys` entry) and appends to `monad-testnet.transactions.json`. |
| `redeploy-vault:monad` | Replace CollateralVault alone with today's code and point ScoreManager and the loan engine at it (`lib/redeploy.js`); the new vault gets the old one's multiplier, the loan engine as engine and seizer, and the record gains `eip712.CollateralVault`. Refuses unless the deployer owns both, the vault is not already today's code, `contracts/` is committed and the MON is there. Run once on 28 Sep 2026 (for `lockWithPermit`). Today's vault adds `withdrawWithSig`; that redeploy is **not run** (the testnet contracts are frozen; [`docs/DEPLOY-LATER.md`](../../docs/DEPLOY-LATER.md) has the steps). |
| `deploy-split:monad` | Add PolarisSplit (split-the-bill links) to a deployment that predates it, such as testnet's of 28 Sep 2026: one transaction (1.89M gas measured locally), nothing else moves (`lib/split.js`). Refuses mainnet, a record that already has one, uncommitted `contracts/`, and a deployer short of MON. Writes the record (`contracts.PolarisSplit`, `eip712.PolarisSplit`, an `additions` entry) and appends to `monad-testnet.transactions.json`. **Not run yet.** A fresh `deploy:monad` or `deploy:local` includes PolarisSplit already; `deploy-split:local` does the same on a local node. |
| `check:monad` | Read-only live check of AUSD, the forwarders, Multicall3 and gas. |
| `guardian:monad` | The credit guard's status (paused, why and from where, stale, override and until when, thresholds, the acknowledged bad debt, the latest attestation). `GUARD_ACTION=thresholds` sets the `GUARD_*` thresholds (the defaults for any unset; `GUARD_MIN_PRICE=1.001` is the demo's raised peg, decision 28, and applies at once), `GUARD_ACTION=override GUARD_OVERRIDE=pause\|resume\|none` (a resume lasts `GUARD_RESUME_SECONDS`, 3600 by default, at most a day), `GUARD_ACTION=acknowledge` (only bad debt beyond today's counts), `GUARD_ACTION=max-age GUARD_MAX_ATTESTATION_AGE_SECONDS=…`. |
| `CRE_WORKFLOW_OWNER=0x… CRE_WORKFLOW_ID_COLLECTIONS=0x… CRE_WORKFLOW_ID_UNDERWRITE=0x… CRE_WORKFLOW_ID_GUARDIAN=0x… lock-receivers:monad` | After `cre workflow deploy`: each receiver accepts only its workflow's owner, name **and** id, moves to the production KeystoneForwarder, and drops the simulation transmitter (in that order; idempotent). The production forwarder must answer `typeAndVersion()` as Chainlink's KeystoneForwarder; Chainlink's MockKeystoneForwarder (which anyone can call) is refused before anything is sent, on Monad testnet only Chainlink's own address is taken, and the forwarder is read back and checked again before the transmitter is cleared. `CRE_FORWARDER_ADDRESS` is for a local chain only. `CRE_FORWARDER=simulation` adds the identity checks and keeps the simulation forwarder and transmitter. Writes `cre.locked` into the deployment record. |

`deploy:monad` uses **real AUSD** (`0xa9012a05…22dC`) and checks its EIP-712
domain on deploy; it refuses Monad mainnet, and refuses to start without the
MON a rough estimate says it needs. Configuration (all optional) is documented
at the top of `scripts/deploy-monad.js`: `AUSD_MODE`, `TREASURY`,
`GRACE_SECONDS` (3600), `MIN_INTERVAL_SECONDS` and `MIN_PERIOD_SECONDS` (60,
so a plan plays out on camera; weekly plans still work), `CRE_FORWARDER`
(`simulation` by default, `production` once deploy access is granted),
`CRE_SIMULATION_TRANSMITTER` (the address of `CRE_ETH_PRIVATE_KEY`, a key kept
for `cre workflow simulate --broadcast` alone; set on all three receivers;
required on the simulation forwarder, read from `CRE_ETH_PRIVATE_KEY` when
unset, and never the deployer, which the script refuses), `CRE_WORKFLOW_OWNER`,
`RELAYER_ADDRESS`, `POOL_SEED_AUSD`, and the guardian's `GUARD_MIN_PRICE`
(0.995), `GUARD_MAX_PRICE` (1.005), `GUARD_MIN_FREE_CASH_AUSD` (1000),
`GUARD_MAX_BAD_DEBT_BPS` (500), `GUARD_MIN_ORIGINATED_AUSD` (10000),
`GUARD_MAX_PRICE_AGE_SECONDS` (7200), `GUARD_MAX_ATTESTATION_AGE_SECONDS`
(3600). The record names the commit the bytecode was built from
(`sourceCommit`), which `verify:monad` rebuilds from when the sources move on.

**Gas.** Monad bills the gas *limit*. Every script sends through `lib/tx.js`:
`eth_estimateGas` plus 15%, never a blanket limit. Measured locally (gas used,
`e2e:local`): Pay now 271k, open a plan 521k (the first plan on a fresh
deployment, which writes the pool totals and the borrower's loan list for the
first time; 436k for a later one), a collections report 162k, subscribe 335k,
send 167k, claim 63k, an underwriting report 142k, a guardian attestation 140k
(254k for the first; it reads the pool to check the report against it), `reauthorize` 77k; PolarisSplit (Hardhat, one run): open a split of 3 shares 161k, pay a share 138k, close 38k.

## Rehearse real AUSD on a fork

Testnet runs on a labelled MockAUSD (decision 24), so the real-AUSD path
(`AUSD_MODE=ausd`) has not run there. It can be rehearsed on a local anvil
fork of Monad testnet, where Agora's AUSD, Agora's faucet and Chainlink's
simulation forwarder are as they stand on testnet, without sending anything
to testnet itself:

```bash
anvil --port 18555 --fork-url https://testnet-rpc.monad.xyz --chain-id 10143 --fork-block-number <a recent block> --prune-history 300
pnpm --filter @polarispay/contracts deploy:fork             # real AUSD by default; writes deployments/monad-fork.json (git-ignored)
pnpm --filter @polarispay/contracts fund-pool:fork          # real AUSD from Agora's faucet into the credit pool (POOL_FUND_AUSD, default 10,000)
pnpm --filter @polarispay/contracts check:deployment:fork   # the read-back check:deployment:monad does, against the fork record
pnpm --filter @polarispay/contracts fork:smoke              # the money paths on real AUSD, one PASS or FAIL line each
```

The `monadFork` network (`MONAD_FORK_RPC_URL`, default `http://127.0.0.1:18555`,
chain 10143) signs with the node's own unlocked accounts and reads no key from
`.env`: account 0 deploys, account 1 is the CRE simulation transmitter, account
2 relays. Every fork script first checks that the RPC is a local anvil or
Hardhat node forking another chain, with chain id 10143 (`lib/fork.js`), and
`deploy:monad` refuses a `monadTestnet` RPC that is a local node, so a fork
never writes `monad-testnet.json`. `deploy:local` still refuses
`AUSD_MODE=ausd`. The faucet pays 10,000 AUSD a drip, one drip a minute for
everyone; the fork scripts move the fork's clock past that wait.

Run on 6 Oct 2026, on a fork of testnet block 68,489,346: `check:deployment:fork`
passed 63 of 63 and `fork:smoke` 14 of 14. On the fork, that shows: the deploy
script's AUSD domain check passes against the real token; the pool takes real
AUSD from the faucet; Pay now (an AUSD `ReceiveWithAuthorization` signed under
the domain AUSD reports, "Agora Dollar" v1 on chain 10143) pays the merchant
less the 0.5% fee, and the same authorization signed under version "2" is
refused; Pay in 4 opens with an ERC-2612 `permit` on AUSD and pays the merchant
from the pool; a collections report through Chainlink's MockKeystoneForwarder
collects instalment 1 by `transferFrom`; Subscribe charges period 1 under an
AUSD permit; a link is sent and claimed; a split share paid by
`ReceiveWithAuthorization` goes straight to the organiser; no user wallet held
MON or sent a transaction. The underwriting and collections reports are
hand-built, as in `e2e:local`: no CRE workflow, DON or Nansen call runs. The
fork bills gas used, not the gas limit as Monad does, and has none of Monad's
block timing.

No gap turned up in AUSD: `receiveWithAuthorization`, `permit`, `nonces`,
`allowance`, `transferFrom` and `eip712Domain` behave as the contracts and
MockAUSD assume. One gas finding: Chainlink's mock forwarder catches a
receiver's revert cheaply, so `eth_estimateGas` on `forwarder.report(...)`
can settle on a limit where the receiver runs out of gas inside the catch and
the delivery still succeeds, with `ReportProcessed` result false. In one run a
one-instalment collections report estimated 151,547 gas and used about 193,000;
sent at the estimate plus 15% it was refused that way. The local
MockKeystoneForwarder writes `lastRevertData` in its catch, which makes failing
dearer than succeeding and hides this in `e2e:local`. `fork:smoke` sizes each
report from a traced delivery on the path where the receiver succeeds.

**Resolved (7 Oct 2026).** Measured read-only on Monad testnet
(`eth_estimateGas` and `debug_traceCall` of `forwarder.report(...)` from the
simulation transmitter, against the deployed receivers; `pnpm --filter
@polaris/cre-workflows report-gas`, numbers in
[`workflows/evidence/gas/`](../../workflows/evidence/gas/)): Monad's estimate
undershoots the same way, by much less than the fork's. Every collections
report that collected or liquidated failed at its own estimate, short by 712
gas for one collection (estimate 252,016, needed 252,728) up to 17,793 gas
(2.07%) for a 25-task report (860,097 against 877,890); so did the guardian's
first attestation, replayed at its block (1,080 short), while the underwriting
reports and the later guardian rounds built now delivered at their estimates.
The three reports delivered on 28 Sep needed 276,515 to
293,068 gas and were sent with 317,165 to 335,786: the 15% headroom covered
the shortfall. The cause is EIP-150: the forwarder reaches the receiver
through two calls (`report` → `this.route` → `onReport`), each of which must
keep back 1/64 of what it passes on, and an estimator that only checks the
transaction succeeds cannot see that go missing behind the forwarder's catch.
The workflows now lift a forwarder-level estimate by (64/63)² (+3.2%) before
the headroom (`deliveryGas` in `workflows/src/shared/evm.ts`), which covers
every measured report with at least 4,001 gas to spare; the test
`workflows/test/gas.test.ts` holds the sizing to those numbers. On
`demo:local`'s fork, the local CRE runners still answer the estimate with the
gas of a traced delivery (`tracedDeliveryGas` in
`workflows/e2e/helpers/local-evm.ts`), since anvil's estimate settles on the
catch path; the workflow lifts that the same way.

## Contracts

| Contract | Role |
|---|---|
| `PolarisCheckout` | Pay now, Pay in 4 and Subscribe from signatures. The **only** loan originator. Asks the credit guard before a Pay in 4 plan; `reauthorize` restores a lost allowance. |
| `PolarisLoanEngine` | Pay in 4 plans: merchant paid from the pool; permissionless `collectInstallment`; `repayWithSig`; liquidation past grace. Keeps the pool totals the guardian attests (`totalOwed`, `totalOriginated`, `badDebt`, `poolState()`). |
| `ScoreManager` | 300–850 scores and credit lines; `underwrite(user, facts)` computes the opening score on chain, capped at $1,000, and opens nothing for a thin file (`isThinFile`: under 90 days or 10 transactions). |
| `PolarisPayments` | Direct payments (`payWithAuthorization`) and subscriptions (`subscribeFor`, `chargeDue`). 0.5% fee. |
| `PolarisSend` | Send dollars as a link; claim to any address with the link key's signature. |
| `PolarisSplit` | Split the bill by link: the organiser opens a split of named or equal shares; each friend pays exactly their share by ERC-3009, straight on to the organiser; the organiser can close it. No owner, no fee, no custody. **Not on Monad testnet yet** (`deploy-split:monad`, below). |
| `MerchantRegistry` | Merchants, registered by their own signature (`registerFor`), activated with a cap. |
| `CollateralVault` | Secured credit (Boost): `lockWithPermit` and `withdrawWithSig`, both relayed, so a borrower never holds MON. Nothing leaves while any debt is outstanding. Monad testnet's vault predates `withdrawWithSig` (below). |
| `BatchSettlement` | Batch payouts with memos. |
| `cre/CollectionsReceiver` | CRE `polaris-collections` (cron): collects, charges, liquidates in a batch. |
| `cre/UnderwritingReceiver` | CRE `polaris-underwrite` (HTTP): facts → `ScoreManager.underwrite`. |
| `cre/GuardianReceiver` | CRE `polaris-guardian` (cron): Chainlink AUSD/USD (Monad mainnet) + pool state → the credit guard `openPlan` asks; pool health as an `AggregatorV3Interface` feed. |
| `cre/PolarisReceiver` | What the three receivers add to the template: the simulation transmitter guard, a refusal to run with the forwarder check off, the report-kind check. |
| `cre/ReceiverTemplate`, `cre/IReceiver`, `interfaces/AggregatorV3Interface` | Chainlink's, verbatim (MIT). |
| `cre/MockKeystoneForwarder`, `cre/MockPriceFeed` | Local stand-ins for Chainlink's mock forwarder and the AUSD/USD feed. Tests, `e2e:local` and local chains only. |
| `MockAUSD` | A mock AUSD: 6 decimals, ERC-2612, ERC-3009, AUSD's EIP-712 name `"Agora Dollar"`, ERC-20 name "Mock AUSD", open `mint`. Local chains, and Monad testnet's labelled stand-in while the deployer holds no real AUSD (`AUSD_MODE=mock`, decision 24). Never mainnet. |

## Interfaces for the SDK, relayer, indexer and CRE workflows

**ABIs**: `abi/<Name>.json`, and typed indexes (`import { polarisCheckoutAbi } from "@polarispay/contracts/abi"`;
the `.d.ts` gives viem full inference). Regenerate with `pnpm --filter @polarispay/contracts abi`; a test fails if they drift.
**Deployment**: `deployments/monad-testnet.json` (written by `deploy:monad`, deployed 28 Sep 2026; read it back with
`check:deployment:monad`, which checks every address and role on chain; `monad-testnet.transactions.json` decodes all 34 of its transactions),
`deployments/monad-local.json` (each local run; git-ignored), `deployments/monad-fork.json` (`deploy:fork`; git-ignored). Each holds every address with its block and
transaction, ABI paths, `eip712` (domain and struct types per contract), `roles`, `cre` and `demo`.
**Signing types**: `lib/eip712.js`. **CRE encoders**: `lib/cre.js`.

### PolarisCheckout

EIP-712 domain `{ name: "PolarisCheckout", version: "1", chainId, verifyingContract }`.

```
PlanIntent(address buyer,address merchant,uint256 principal,uint32 installments,uint64 interval,string orderId,uint256 nonce,uint256 deadline)
SubscribeIntent(address buyer,address merchant,uint256 planId,uint256 pricePerPeriod,uint64 periodSeconds,string orderId,uint256 nonce,uint256 deadline)
```

`nonce` is `nonces(buyer)`, one sequence shared by both intents. `deadline` must be
at most `MAX_SIGNATURE_WINDOW` (1 hour) ahead of the block. The order key is
`keccak256(abi.encodePacked(merchant, orderId))`, identical to the PolarisPayments
payment id; an order settles once, in one mode, at its quoted price if
`PolarisPayments.quoteOrder` pinned one. `openPlan` and `subscribe` record the
order on PolarisPayments (`settledByCheckout(orderKey)`), which then refuses
every payment on it with `OrderAlreadySettled(paymentId)`: a Pay now
authorization the buyer signed before choosing Pay in 4 or Subscribe can't be
redeemed on top of the plan, whether it is sent to the checkout or straight to
PolarisPayments, and whichever checkout is appointed later. The checkout must be
PolarisPayments' appointed `checkout` for Pay in 4 as well as Subscribe.

| Function | Buyer signs | Notes |
|---|---|---|
| `pay(buyer, merchant, amount, orderId, validAfter, validBefore, v, r, s) → orderKey` | AUSD `ReceiveWithAuthorization`, `to` = **PolarisPayments**, `nonce` = order key | Relays `PolarisPayments.payWithAuthorization`. |
| `openPlan(PlanIntent, bytes signature, PermitSignature) → loanId` | `PlanIntent` + AUSD `Permit`, spender = **PolarisLoanEngine**, value = `quotePlan(...).permitValue` | Merchant paid `principal` at once. |
| `subscribe(SubscribeIntent, bytes signature, PermitSignature) → subId` | `SubscribeIntent` + AUSD `Permit`, spender = **PolarisPayments** (e.g. 12 periods) | Plan terms must equal the intent (`PlanMismatch`). |
| `quotePlan(buyer, principal, installments, interval) → PlanQuote` | | `totalOwed, interest, installmentAmount, permitValue, creditLimit, activeDebt, available, withinLimit`. |
| `reauthorize(buyer, PermitSignature) ` | AUSD `Permit`, spender = **PolarisLoanEngine**, value >= `loanEngine.activeDebtOf(buyer)` | Restores a lost allowance; emits `Reauthorized`, which the collections workflow's log trigger collects on. Only while the allowance no longer covers what the buyer owes (`AlreadyAuthorized` otherwise, so a copy of openPlan's permit can't fire a retry). A permit someone landed on the token first still emits `Reauthorized` (its allowance is in force), once (`reauthorizedThrough`). Not stopped by `pause()` or the credit guard. **Not on Monad testnet yet**: the deployed PolarisCheckout predates these two checks (`verify:monad` verifies it from the deploy commit). |
| `creditPaused() → (bool paused, uint8 reasons)` | | What `openPlan` would decide now (fails open). |
| `orderOf(merchant, orderId)`, `orderKeyOf`, `planIntentDigest`, `subscribeIntentDigest`, `invalidateNonce()`, `pause()`/`unpause()`, `setCreditGuardian(guardian)` (owner) | | |

`PermitSignature = (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)`; `deadline = 0`
means no permit (the standing allowance is used). A permit **replaces** the allowance, which
is why `permitValue` covers every plan the buyer already has open.

Events (topic 1–3 indexed):

```
CheckoutPaid(bytes32 indexed orderKey, address indexed merchant, address indexed buyer, string orderId, uint256 amount, uint256 fee)
PlanOpened(bytes32 indexed orderKey, address indexed merchant, address indexed buyer, uint256 loanId, string orderId, uint256 principal, uint256 totalOwed, uint32 installments, uint64 interval, uint64 firstDueAt)
SubscriptionStarted(bytes32 indexed orderKey, address indexed merchant, address indexed buyer, uint256 subId, uint256 planId, string orderId, uint256 pricePerPeriod, uint64 periodSeconds, uint64 nextChargeAt)
NonceInvalidated(address indexed buyer, uint256 nonce)
Reauthorized(address indexed buyer, uint256 value, uint256 deadline)
CreditGuardianSet(address indexed guardian)
```

Instalment *i* (0-based) of a plan is due at `firstDueAt + i * interval`, and `firstDueAt` is one
interval after the plan opens: **nothing is taken from the buyer at checkout** (no down payment), so a
Pay in 4 screen or receipt must not show a "paid today" row. Each instalment is a step of the engine's
ceiling ladder, `thresholdFor(k) - thresholdFor(k - 1)` with `thresholdFor(k) = ceil(totalOwed * k / n)`
($200 weekly: 50.383562, 50.383561, 50.383562, 50.383561). Errors: `InvalidSignature`,
`InvalidAccountNonce(account, current)`, `SignatureExpired`, `SignatureWindowTooLong`,
`OrderAlreadySettled(orderKey)`, `WrongAmount(quoted, offered)`, `PlanMismatch(planId)`, `EmptyOrderId`,
`ZeroAddress`, `EnforcedPause`, `CreditPausedByGuardian(reasonMask)` (Pay in 4 only), and for `reauthorize`
`NothingOwed(buyer)`, `PermitBelowDebt(value, owed)`, `AlreadyAuthorized(allowance, owed)`, `SignatureExpired`,
`InvalidSignature` (wrong signer, spender or value, or a replayed permit); the engine's `ExceedsCreditLimit`, `InsufficientAllowance(have, need)`,
`MerchantNotEligible`, `InvalidInterval` bubble up unchanged.

### PolarisSplit

EIP-712 domain `{ name: "PolarisSplit", version: "1", chainId, verifyingContract }`.

```
CreateSplit(address organiser,bytes32 salt,uint128[] amounts,bytes32 memoHash,uint64 expiresAt,uint256 deadline)
CloseSplit(bytes32 splitId,uint256 deadline)
```

| Function | Who signs | Notes |
|---|---|---|
| `createSplit(Creation, bytes signature) → splitId` | the organiser: `CreateSplit` | `splitId = keccak256(abi.encode(organiser, salt))`, known before it lands. 1 to 50 shares, each more than zero; open 5 minutes to 60 days. `memoHash` is the hash of the link's words (what it's for, the organiser's name, a label per share: `keccak256(abi.encode(string, string, uint256 billTotal, string[] labels))`); the words themselves never go on chain. |
| `payShare(splitId, index, payer, validAfter, validBefore, v, r, s)` | the friend: AUSD `ReceiveWithAuthorization`, `to` = **PolarisSplit**, `value` = the share's amount, `nonce` = `shareNonce(splitId, index)` = `keccak256(abi.encode(splitId, index))` | The share is recorded (`paidBy`, `SharePaid`) and its dollars forwarded to the organiser in the same call; nothing stays here. |
| `closeSplit(splitId, deadline, bytes signature)` | the organiser: `CloseSplit` | Unpaid shares can no longer be paid. Nothing moves. |
| `splitOf(splitId)`, `sharesOf(splitId) → (amounts, payers)`, `paidBy(splitId, index)` | | Views; `splitOf(...).organiser` is zero for no split. |
| `splitIdOf`, `shareNonce`, `createDigest`, `closeDigest` | | What a client derives and signs, from the code that checks it. |

Why a contract of its own rather than one PolarisPayments order per share, and
why `receiveWithAuthorization` into it rather than a transfer straight to the
organiser, is in its header comment. Every signature's cutoff must fall within
`MAX_SIGNATURE_WINDOW` (1 hour) of the block. Errors: `SplitExists`,
`SplitNotFound`, `SplitIsClosed`, `SplitExpired`, `ShareOutOfRange`,
`ShareAlreadyPaid`, `NoShares`, `TooManyShares`, `InvalidAmount(index)`,
`InvalidExpiry`, `InvalidSignature`, `SignatureExpired`,
`SignatureWindowTooLong`, `UnexpectedAmount`; the token's own errors (a wrong
signer, amount, share or split: `InvalidAuthorizationSignature`; an expired
authorization) bubble up unchanged. Events: `SplitCreated(splitId, organiser,
total, amounts, expiresAt, memoHash)`, `SharePaid(splitId, index, payer,
amount, paidCount, shareCount)`, `SplitClosed(splitId, organiser, paidCount,
shareCount)`.

### CollateralVault

Boost: dollars a borrower locks to raise their limit (`ScoreManager.creditLimitOf` adds `creditBoostOf`,
`lockedOf × creditMultiplierBps / 10000`, at face value for an account with no unsecured line).

| Function | Who signs | Notes |
|---|---|---|
| `lockWithPermit(borrower, amount, deadline, v, r, s)` | the borrower: AUSD `Permit`, spender = **the vault**, value = `amount` | Locked into the borrower's own position. Not wrapped in try/catch: no standing allowance is ever used without a fresh signature. |
| `withdrawWithSig(borrower, amount, deadline, bytes signature)` | the borrower: `Withdraw` (below) | Pays `borrower`, never the caller, by exactly `withdraw`'s rules (one internal path): nothing while `loanEngine.activeDebtOf(borrower) > 0` (`DebtOutstanding(debt)`), never more than `lockedOf` (`InsufficientCollateral`), never zero (`ZeroAmount`); emits `CollateralWithdrawn(user, amount, newTotal)`; `nonReentrant`. |
| `lock(amount)`, `withdraw(amount)` | | The caller's own position, for an account that holds MON. |
| `withdrawable(user)` | | What either withdrawal allows now: all of `lockedOf`, or 0 while any debt is outstanding. |
| `nonces(borrower)`, `invalidateNonce()`, `withdrawDigest(borrower, amount, nonce, deadline)`, `DOMAIN_SEPARATOR()`, `eip712Domain()` | | One sequential nonce per borrower: a signature is spent once and a newer one retires every older one. `invalidateNonce` (emits `NonceInvalidated(borrower, nonce)`) cancels one for a borrower who holds gas. |
| `seize(user, amount, to)` | | A registered seizer (the loan engine) on default. |

EIP-712 domain `{ name: "CollateralVault", version: "1", chainId, verifyingContract }`:

```
Withdraw(address borrower,uint256 amount,uint256 nonce,uint256 deadline)
```

`nonce` is `nonces(borrower)`; `deadline` must be at most `MAX_SIGNATURE_WINDOW` (1 hour) ahead of the
block. Signatures are checked as PolarisCheckout checks them: the borrower's key first, then ERC-1271 for
an account with code. Errors: `InvalidSignature` (wrong signer, amount, deadline, vault or chain, a spent
or future nonce), `SignatureExpired`, `SignatureWindowTooLong`, and `withdraw`'s own. The domain is built
from immutables rather than OpenZeppelin's `EIP712` (whose fallback strings are storage), so every storage
slot of the earlier vault keeps its place and `nonces` comes after them (pinned by a test).

**Monad testnet runs the vault from `20518d2`** (`lockWithPermit`, no `withdrawWithSig`; it answers no
`eip712Domain()`), and the testnet contracts are frozen. The relayer and the app read the vault itself:
there, the relayer answers `withdraw_unavailable` and the app says taking out isn't available on this
network yet. `verify:monad` still verifies it from its `sourceCommit`; `redeploy-vault:monad` replaces it
on the team's go ([`docs/DEPLOY-LATER.md`](../../docs/DEPLOY-LATER.md)). Every local and fork deployment
(`deploy:local`, `deploy:fork`, `demo:local`) has today's vault.

### Chainlink CRE receivers

All three extend Chainlink's `ReceiverTemplate` through `PolarisReceiver`: `onReport(metadata, report)`
accepts only the configured forwarder, and once `setExpectedAuthor` + `setExpectedWorkflowName` (+
`setExpectedWorkflowId`) are set, only that workflow owner, name and id (`lock-receivers:monad`). While
`simulationTransmitter` is set, only that `tx.origin` may deliver (the CRE simulator's own key); a body
whose first word is not the receiver's kind is refused with `UnknownReportKind(kind)` before decoding.
Names travel as `bytes10` = the first 10 hex chars of `sha256(name)` as ASCII:
`polaris-collections` = `0x38323961376630323863`, `polaris-underwrite` = `0x39333731613831386437`,
`polaris-guardian` = `cre.workflowNameBytes10("polaris-guardian")` (recorded in the deployment).
Encoders and decoders for all three formats: `lib/cre.js`.

**CollectionsReceiver** (`polaris-collections`: a cron, and an EVM log trigger on
`PolarisCheckout.Reauthorized` for the instant retry). One report body for both:

```
abi.encode(uint8 kind = 1, (uint8 action, uint256 id)[] tasks)
action 1 = PolarisLoanEngine.collectInstallment(id)   2 = PolarisPayments.chargeDue(id)   3 = PolarisLoanEngine.liquidate(id)
```

`checkTasks((uint8,uint256)[]) → bool[]` is the cron's one batched read (actionable at this block).
`dueTasksFor(address borrower) → (uint8,uint256)[]` is the retry's: a collect task for each of the
borrower's plans whose instalment is due now (from `PolarisLoanEngine.loanIdsOf`).
Events: `TaskExecuted(uint8 indexed action, uint256 indexed id, uint256 amount)`,
`TaskSkipped(uint8 indexed action, uint256 indexed id, bytes reason)` (the target's revert data:
`InsufficientAllowance(have, need)` = re-sign, `InsufficientBalance(have, need)` = top up, `NotDue` /
`LoanNotActive` = stale candidate), `CollectionsRun(uint256 tasks, uint256 executed, uint256 skipped)`.
A task that runs out of gas reverts the whole report with `InsufficientGasForTask(index)` so the
forwarder can retry.

**UnderwritingReceiver** (`polaris-underwrite`, HTTP). Report body:

```
abi.encode(uint8 kind = 2, (address user, address linkedWallet, Facts facts)[] items)
Facts = (uint32 walletAgeDays, uint32 txCount, uint64 stableBalance, uint32 defiTenureDays,
         uint16 priorLiquidations, uint16 relatedWallets, bool exchangeFunded, uint64 observedAt)
```

`stableBalance` is 6-decimal base units; `observedAt` must be within 15 minutes of the block.
A report must show a history (`ScoreManager.isThinFile`): at least `MIN_HISTORY_DAYS` (90) days
since the oldest activity and `MIN_HISTORY_TXS` (10) transactions, over the account and its linked
wallet. A thin file is refused with `ThinFile(walletAgeDays, txCount)` and records nothing, so a fresh
account gets no unsecured line until it links a history wallet (collateral works meanwhile, at face
value); a report that declines the wallet is recorded whatever the history. The balance does not count
towards a history. The off-chain decision and the workflow should skip thin files rather than send them.
Events: `UnderwritingApplied(address indexed user, address indexed linkedWallet, uint16 score)`,
`UnderwritingRefused(address indexed user, address indexed linkedWallet, bytes reason)` (e.g.
`StaleEvidence`, `ThinFile(walletAgeDays, txCount)`, `AlreadyHasRecord`, `WalletAlreadyLinked(wallet, user)`, `UserIsLinkedHistory(user, account)`,
`WalletAlreadyUnderwritten(wallet)`). One history opens one line: `linkedUserOf(wallet)` backs one
account, a wallet backing an account can't be underwritten itself, and an underwritten account can't be
linked as another's history. While `simulationTransmitter` is set (simulation), only that `tx.origin` may
deliver, so it must be a dedicated CRE key, never the deployer.

**GuardianReceiver** (`polaris-guardian`, cron). Each run reads Chainlink's AUSD/USD on Monad
**mainnet** (`0xE20751C7B5867bCBef815ffc1b284c3f412a9e13`, 8 decimals) and, on testnet,
`currentInputs() → (PoolState state, Thresholds limits, uint256 acknowledgedBadDebt)` (one read: the
engine's `poolState() = (freeCash, totalOwed, badDebt, totalOriginated)`, the thresholds, and the bad
debt the owner acknowledged). Report body:

```
abi.encode(uint8 kind = 3, Attestation a)
Attestation = (uint80 priceRoundId, int256 price, uint64 priceUpdatedAt,
               uint256 freeCash, uint256 totalOwed, uint256 badDebt, uint256 totalOriginated,
               uint64 observedAt, bool creditPaused, uint8 reasons)
reasons: 1 depeg (price < minPrice or price > maxPrice)   2 low cash (freeCash < minFreeCash)
         4 bad debt (totalOriginated >= minOriginated and badDebt - acknowledged > maxBadDebtBps of totalOriginated)
         8 stale price (priceUpdatedAt == 0 or observedAt - priceUpdatedAt > maxPriceAge)
creditPaused must equal reasons != 0
```

`evaluate(Attestation) → uint8` is the verdict formula (`cre.guardianReasons` in JS); a report whose
verdict differs is refused (`AttestationRefused(observedAt, VerdictMismatch(...))`), as is one whose
low-cash and bad-debt bits are not the live pool's (`PoolMismatch`: a report claiming an empty pool
against a funded one cannot pause anything), one out of order (`AttestationOutOfOrder`), dated more
than 5 minutes ahead (`ObservationInFuture`) or already older than `maxAttestationAge`
(`AttestationTooOld`). Accepted: `CreditGuardUpdated(uint80 indexed round, bool indexed creditPaused,
uint8 reasons, Attestation attestation)`. Thresholds (defaults: $0.995 to $1.005, $1,000, 500 bps from
$10,000 lent, 7200 s) and `maxAttestationAge` (3600 s) are owner-set (`setThresholds`,
`setMaxAttestationAge`; events `ThresholdsSet(Thresholds)`, `MaxAttestationAgeSet`).
`isCreditPaused() → (bool, uint8)` is what the checkout asks: the owner override first
(`setOverride(mode, until)`: 2 ForcePause with `until` 0 reads as reason `0x80`; 1 ForceResume must
end (`until`) within `MAX_FORCE_RESUME`, a day, and reads as None after it; 0 None; event
`CreditGuardOverridden(mode, until)`). Then low cash and bad debt **from `pool.poolState()` in the same
call**, never stale; then depeg and stale price from the latest attestation judged by today's
thresholds, which **fail open** when there is no attestation or it is older than `maxAttestationAge`.
So the DON is trusted for the mainnet price only. `creditStatus()` returns all of it for a badge,
with `poolReasons` and `priceReasons` apart, the override's end and the acknowledged bad debt.
Bad debt is measured against lifetime originations, not today's outstanding book: bad debt never
falls while the book shrinks with every repayment, so against the book a quiet week would trip the
guard with no new loss, and a paused book could never lift it. The ratio applies only once
`minOriginated` has been lent (one default on a young pool is not a portfolio), and
`acknowledgeBadDebt()` (owner; event `BadDebtAcknowledged`) counts only bad debt beyond what the
owner has looked into, leaving the price checks alone.
It is also an `AggregatorV3Interface`: description `"Polaris pool health, computed by CRE"`,
8 decimals, one round per accepted attestation, answer = the pool's free cash when the report
landed (read from the pool) in USD at the attested price, saturating at int192's maximum (0 when
the verdict paused credit), `startedAt = updatedAt = observedAt`. It is a Polaris attestation
computed by a CRE workflow, not a Chainlink Data Feed or Proof of Reserve.

**Forwarders on Monad testnet**: simulation `0xB9F79d863261869B234c481D1f9A7af84AeAd192` (default),
production `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`. To move to production after deploy access:
`lock-receivers:monad` (owner, name and id on all three receivers, then the production forwarder,
then `setSimulationTransmitter(0)`). Under `cre workflow simulate` a reverted `onReport` still reads
as success, so judge runs by the events above.

## Tests

`pnpm --filter @polarispay/contracts test`. The Metropolis suites are named for the attack each
refuses: `test/metropolis/Checkout.test.js` (a relayer cannot open a plan the buyer did not sign,
redirect a payment, replay an intent or a permit, or reenter), `CreReceivers.test.js` (forged
reports, the forwarder, owner and name checks, stale or repeated underwriting, a reused history
wallet, a stranger on the simulation forwarder, out-of-gas reports, and the three report formats
round-tripped), `Guardian.test.js` (the credit guard: each reason, verdicts that are not the chain's,
a report whose pool is not the chain's, the pool never failing open, replayed or stale attestations,
fail open on the price, the owner's override and its end, a default on a young pool and the
acknowledgement with a depeg after it, thresholds applying at once, the ceiling and a round write
that saturates, the feed-shaped view, the formula fuzzed against `lib/cre.js`, and Pay now,
Subscribe, Send and open plans all working while credit is paused), `Reauthorize.test.js`
(re-signing: valid, expired, wrong signer, spender or value, replay, openPlan's permit copied in
first, a permit landed on the token first, too small, then the retry collects),
`LoanEngineTotals.test.js` (the pool totals equal the sum over loans after every step, table-driven
and random), `LockReceivers.test.js` (and the mock forwarder refused as the production one),
`PolarisSplit.test.js` (split the bill: the happy path with no gas and no custody, a share paid
twice, an overpay or underpay, a closed split, a wrong signer for a share, a create or a close, a
replayed authorization, create or close, and every expiry: the split's, the authorization's, a
create's and a close's; a token that short-delivers or reenters), `DeploySplit.test.js`
(PolarisSplit in a fresh deployment, and added to one that predates it with nothing else moving),
`Deploy.test.js` (every role the deployment grants), `Interfaces.test.js` (ABIs and EIP-712 types
stay true), `CollateralWithdraw.test.js` (taking collateral out by signature: paid to the borrower and
never the relayer, a wrong signer, amount, deadline, vault or borrower, a replay, a newer signature and
`invalidateNonce` retiring an older one, an expired or too-long deadline, refused while a loan is open and
paid once it is repaid, more than is locked, zero, after a seizure, an ERC-1271 account, a token that
reenters, and the storage layout of the earlier vault kept), `CollateralPermit.test.js` (locking by permit), `Verify.test.js` (the deploy commit's PolarisCheckout rebuilt from git and told from
today's), `Redeploy.test.js` (the guardian replaced and read back), `RedeployVault.test.js` (the deploy commit's
vault and the one testnet runs today, each rebuilt from git and replaced: a borrower locks and takes out
with no MON, the old vault's lock stays withdrawable only by its owner, the deployment reads back).

## Attribution

`contracts/cre/ReceiverTemplate.sol` and `IReceiver.sol` are Chainlink's (MIT), from the CRE
consumer-contract docs. OpenZeppelin Contracts 5 (MIT). Written with Claude Code.

# Slither: static analysis triage

Run on 7 Oct 2026 from `packages/contracts` (after
`CollateralVault.withdrawWithSig`), mocks filtered out, informational and
optimization detectors off:

```bash
slither . --filter-paths "node_modules|Mock" --exclude-informational --exclude-optimization
```

97 results: 5 High, 28 Medium, 64 Low. None is a vulnerability on review;
each class is below with the reason. Re-run after any contract change and
update this file. The vault's signed withdrawal added two, both of a class
already triaged here: `unused-return` on `CollateralVault._requireSigned`'s
`tryRecoverCalldata` and `timestamp` on `withdrawWithSig`'s deadline (6 Oct:
95 results, 27 Medium, 63 Low).

## High

| Detector | Where | Verdict |
|---|---|---|
| `arbitrary-send-erc20` (2) | `PolarisLoanEngine._applyPayment`, `_recoverFromAllowance` | By design. `from` is always the loan's own `borrower`, who opened the loan with a signed `PlanIntent` and an ERC-2612 permit to the engine; the amount is bounded by the schedule (`collectInstallment`) or the outstanding debt (`liquidate`). Collection is permissionless on purpose so the CRE collections workflow can run it; it can only take what is due |
| `reentrancy-balance` (3) | `PolarisSend._pull`, `PolarisSplit._receive`, `PolarisPayments._receiveAuthorized` | False positive. The balance read before and after `receiveWithAuthorization` is a defensive check that the immutable stablecoin delivered exactly `amount`; the stablecoin is AUSD (or the labelled mock), fixed at construction, and every entry point is `nonReentrant` |

## Medium

| Detector | Verdict |
|---|---|
| `reentrancy-no-eth` (5) | The external calls go to the protocol's own contracts, fixed at deploy (`ScoreManager`, `CollateralVault`, `PolarisPayments`, `PolarisLoanEngine`) or to the stablecoin's `permit`; the public entry points (`openPlan`, `subscribe`, `collectInstallment`, `repay`, `liquidate`) are `nonReentrant` |
| `tx-origin` (1) | Deliberate (`PolarisReceiver._checkDelivery`, commented in the code): under CRE simulation the forwarder is a public contract anyone can call, so only the simulator's own broadcasting key (`tx.origin`) proves our workflow ran. `lock-receivers:monad` moves to the production KeystoneForwarder and clears the transmitter |
| `divide-before-multiply` (1) | Intended: `ScoreManager.scoreFromFacts` scores wallet age in whole 30-day steps (`days / 30 * 2`) |
| `incorrect-equality` (4) | Enum and zero comparisons (`status == Active`, `amount == 0`, `overrideMode == ForceResume`), not balance equalities |
| `uninitialized-local` (5) | Locals that intentionally start at zero: `PolarisSplit.createSplit` `total`, `ScoreManager.creditLimitOf` `boost`, and counters in `CollectionsReceiver` (`n`, `executed`, `reason`) |
| `unused-return` (12) | Mostly `ECDSA.tryRecover`'s error code (`CollateralVault._requireSigned` among them, which checks it): the recovered address is compared with an expected signer that is checked non-zero (`tryRecover` returns `address(0)` on failure), so a bad signature never matches. The rest are tuple reads that need one field (`payments.payments(orderKey)`) and `payWith`'s payment id, unused in `pay`; two are test doubles |

## Low

`timestamp` (34: due dates, grace, expiry and signature deadlines are time-based by design),
`missing-zero-check` (11: constructor and setter addresses, set by the
deployer and read back by `check:deployment`), `calls-loop` (9: batch
settlement and report items, bounded), `reentrancy-events` (6) and
`reentrancy-benign` (3) (events or writes after calls to the protocol's own
contracts), `shadowing-local` (1).

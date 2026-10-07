// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ICreditGuard} from "./interfaces/ICreditGuard.sol";

/// The credit pool the guard reads: PolarisLoanEngine.
interface IPolarisPool {
    /// Same layout as PolarisLoanEngine.PoolState.
    struct PoolState {
        uint256 freeCash;
        uint256 totalOwed;
        uint256 badDebt;
        uint256 totalOriginated;
    }

    function poolState() external view returns (PoolState memory);
    function stablecoin() external view returns (address);
}

/**
 * @title CreditGuard
 * @notice Decides, from the credit pool's own figures read live, whether
 *         PolarisCheckout may open new Pay in 4 plans. Pay now, Send, Split
 *         and Subscribe never ask it.
 *
 * @dev The pool holds USDC, Arc's native unit of account, so there is no
 *      peg to watch: the only things that make new credit unsafe are in the
 *      pool itself, and they are read at the moment a plan opens, never from
 *      an attestation that could be stale or forged. Two reasons pause new
 *      plans:
 *        - REASON_LOW_CASH: free cash (what can pay a merchant now) is below
 *          `minFreeCash`;
 *        - REASON_BAD_DEBT: unacknowledged bad debt exceeds `maxBadDebtBps`
 *          of lifetime originations, once at least `minOriginated` has been
 *          lent (on a young pool one loss is a large share).
 *      The owner can force credit paused (REASON_OWNER_PAUSE), force it open
 *      for at most MAX_FORCE_RESUME, acknowledge the bad debt it has looked
 *      into, and change the thresholds. Nothing here can move money.
 *
 *      PolarisCheckout calls `isCreditPaused()` with a gas-capped staticcall
 *      and fails open on a revert, so a broken guard can never freeze
 *      checkout; a guard that answers "paused" stops only new plans, never
 *      collections or repayments.
 */
contract CreditGuard is Ownable, ICreditGuard {
    uint8 public constant REASON_LOW_CASH = 2;
    uint8 public constant REASON_BAD_DEBT = 4;
    /// The owner forced credit paused.
    uint8 public constant REASON_OWNER_PAUSE = 0x80;

    /// The longest the owner may force credit open in one call.
    uint32 public constant MAX_FORCE_RESUME = 1 days;

    enum Override {
        None,
        ForceResume,
        ForcePause
    }

    /// The policy. Defaults (lib/keeper.js GUARD_DEFAULTS): $1,000 of free
    /// cash, 5% bad debt once $10,000 has been lent.
    struct Thresholds {
        /// Least free pool cash, USDC base units (6 decimals).
        uint256 minFreeCash;
        /// Most unacknowledged bad debt, in basis points of lifetime originations.
        uint16 maxBadDebtBps;
        /// Lifetime originations, USDC base units, below which the bad-debt
        /// ratio is not applied.
        uint256 minOriginated;
    }

    /// Everything a client needs to show the guard, in one read.
    struct CreditStatus {
        /// What PolarisCheckout.openPlan applies now.
        bool paused;
        /// Why it is paused (0 when open).
        uint8 reasons;
        /// Low cash and bad debt, from the pool now, whatever the override.
        uint8 poolReasons;
        /// The override in force now (a forced resume past its end reads None).
        Override overrideMode;
        /// When the forced resume in force ends; 0 when there is none.
        uint64 overrideUntil;
        /// Bad debt the owner acknowledged; only bad debt beyond it counts.
        uint256 badDebtAcknowledged;
        IPolarisPool.PoolState pool;
        Thresholds thresholds;
    }

    IPolarisPool public immutable pool;

    Thresholds private _thresholds;
    /// The override as set; `activeOverride()` is the one in force.
    Override public overrideMode;
    /// When a forced resume ends (unix seconds); 0 for the other modes.
    uint64 public overrideUntil;
    /// Bad debt the owner acknowledged (`acknowledgeBadDebt`), USDC base units.
    uint256 public badDebtAcknowledged;

    event ThresholdsSet(Thresholds thresholds);
    event CreditGuardOverridden(Override mode, uint64 until);
    event BadDebtAcknowledged(uint256 badDebt);

    error ZeroAddress();
    error InvalidThresholds();
    error InvalidOverride(Override mode, uint64 until);

    constructor(address initialOwner, IPolarisPool _pool, Thresholds memory thresholds_) Ownable(initialOwner) {
        if (address(_pool) == address(0)) revert ZeroAddress();
        pool = _pool;
        _setThresholds(thresholds_);
    }

    // -----------------------------------------------------------------
    // Owner
    // -----------------------------------------------------------------

    function setThresholds(Thresholds calldata t) external onlyOwner {
        _setThresholds(t);
    }

    /**
     * @notice Force credit paused (`until` 0) or open (`until` in the next
     *         MAX_FORCE_RESUME) whatever the pool says, or (None, `until` 0)
     *         follow the pool again.
     */
    function setOverride(Override mode, uint64 until) external onlyOwner {
        bool ok = mode == Override.ForceResume
            ? until > block.timestamp && until <= block.timestamp + MAX_FORCE_RESUME
            : until == 0;
        if (!ok) revert InvalidOverride(mode, until);
        overrideMode = mode;
        overrideUntil = until;
        emit CreditGuardOverridden(mode, until);
    }

    /**
     * @notice Acknowledge the pool's bad debt so far: from now on only bad
     *         debt beyond it counts toward REASON_BAD_DEBT.
     */
    function acknowledgeBadDebt() external onlyOwner {
        uint256 badDebt = pool.poolState().badDebt;
        badDebtAcknowledged = badDebt;
        emit BadDebtAcknowledged(badDebt);
    }

    // -----------------------------------------------------------------
    // The guard
    // -----------------------------------------------------------------

    /// @inheritdoc ICreditGuard
    function isCreditPaused() public view returns (bool paused, uint8 reasons) {
        Override mode = activeOverride();
        if (mode == Override.ForcePause) return (true, REASON_OWNER_PAUSE);
        if (mode == Override.ForceResume) return (false, 0);
        reasons = poolReasons(pool.poolState());
        paused = reasons != 0;
    }

    /// @notice The override in force now: a forced resume past `overrideUntil` is None.
    function activeOverride() public view returns (Override) {
        Override mode = overrideMode;
        if (mode == Override.ForceResume && block.timestamp >= overrideUntil) return Override.None;
        return mode;
    }

    function creditStatus() external view returns (CreditStatus memory s) {
        (s.paused, s.reasons) = isCreditPaused();
        s.pool = pool.poolState();
        s.poolReasons = poolReasons(s.pool);
        s.overrideMode = activeOverride();
        s.overrideUntil = s.overrideMode == Override.ForceResume ? overrideUntil : 0;
        s.badDebtAcknowledged = badDebtAcknowledged;
        s.thresholds = _thresholds;
    }

    function thresholds() external view returns (Thresholds memory) {
        return _thresholds;
    }

    /// @notice Low cash and bad debt for pool state `s` under the current thresholds.
    function poolReasons(IPolarisPool.PoolState memory s) public view returns (uint8 reasons) {
        Thresholds memory t = _thresholds;
        if (s.freeCash < t.minFreeCash) reasons |= REASON_LOW_CASH;
        if (s.totalOriginated >= t.minOriginated) {
            uint256 acknowledged = badDebtAcknowledged;
            uint256 unacknowledged = s.badDebt > acknowledged ? s.badDebt - acknowledged : 0;
            // unacknowledged / totalOriginated > maxBadDebtBps / 10_000, exactly
            // (bad debt is an integer, so comparing it to the floored limit is exact).
            if (unacknowledged > Math.mulDiv(s.totalOriginated, t.maxBadDebtBps, 10_000)) reasons |= REASON_BAD_DEBT;
        }
    }

    function _setThresholds(Thresholds memory t) private {
        if (t.maxBadDebtBps > 10_000) revert InvalidThresholds();
        _thresholds = t;
        emit ThresholdsSet(t);
    }
}

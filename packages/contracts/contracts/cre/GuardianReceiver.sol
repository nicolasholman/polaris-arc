// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PolarisReceiver} from "./PolarisReceiver.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {ICreditGuard} from "../interfaces/ICreditGuard.sol";

/// The credit pool the guardian attests: PolarisLoanEngine.
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
 * @title GuardianReceiver
 * @notice Receives the Chainlink CRE `polaris-guardian` workflow's signed
 *         attestation of the AUSD peg, and with the pool's own figures decides
 *         whether PolarisCheckout may open new Pay in 4 plans. Pay now, Send
 *         and Subscribe never ask it.
 *
 * @dev The workflow runs on a cron. Each run it reads, in one DON:
 *        - Chainlink's AUSD/USD feed on Monad MAINNET (latestRoundData), the
 *          real price of the real coin (the testnet has no AUSD feed);
 *        - the pool on Monad testnet: `currentInputs()` here returns the loan
 *          engine's `poolState()` (free cash, what buyers owe, bad debt,
 *          lifetime originations), this contract's thresholds, and the bad
 *          debt the owner has acknowledged;
 *      computes the verdict, reaches consensus, and writes one report.
 *
 *      Report body (after the forwarder strips the 109-byte header):
 *        abi.encode(uint8 kind, Attestation a)   kind == REPORT_KIND (3)
 *        Attestation = (uint80 priceRoundId, int256 price, uint64 priceUpdatedAt,
 *                       uint256 freeCash, uint256 totalOwed, uint256 badDebt,
 *                       uint256 totalOriginated, uint64 observedAt,
 *                       bool creditPaused, uint8 reasons)
 *      `price` is the feed's answer with PRICE_DECIMALS (8) decimals, and
 *      `priceRoundId` and `priceUpdatedAt` are that round's, so anyone can
 *      check the cited round on the mainnet feed. The pool figures are the
 *      DON's read of the engine at `observedAt`.
 *
 *      The reasons, a bitmask (`creditPaused == (reasons != 0)`):
 *        REASON_DEPEG        1  price < minPrice, or price > maxPrice
 *        REASON_LOW_CASH     2  freeCash < minFreeCash
 *        REASON_BAD_DEBT     4  totalOriginated >= minOriginated, and bad debt
 *                               beyond what the owner acknowledged is more than
 *                               maxBadDebtBps of totalOriginated
 *        REASON_STALE_PRICE  8  priceUpdatedAt == 0, or observedAt - priceUpdatedAt > maxPriceAge
 *
 *      What the DON is trusted for, and what it is not. Only the price comes
 *      from another chain, so only the price reasons (depeg, stale price) are
 *      taken from the attestation. Low cash and bad debt are facts of this
 *      chain, so `isCreditPaused()` computes them from `pool.poolState()` in
 *      the same call, every time: they never go stale and never fail open,
 *      and no report can set or clear them. The price reasons are judged by
 *      today's thresholds, so a threshold change applies at once, not at the
 *      next report.
 *
 *      Every report is checked twice before it is accepted. Its verdict must
 *      be exactly `evaluate(a)`, the formula applied to its own figures under
 *      the thresholds on chain (else `VerdictMismatch`), so the workflow's
 *      computation and the chain's check each other. And its pool verdict
 *      (low cash, bad debt) must be the live pool's (else `PoolMismatch`), so
 *      a report cannot claim a pool the chain does not have: a report that
 *      says there is no free cash, against a funded pool, is refused. A
 *      threshold change, or the pool crossing one, between the workflow's
 *      read and its write gets one report refused; the next run reads anew.
 *
 *      Why bad debt is measured against lifetime originations, not against
 *      what buyers owe today: bad debt is cumulative and never falls, while
 *      what buyers owe falls every time a plan is repaid. Against lifetime
 *      originations the ratio moves only with new losses or new lending: the
 *      standard cumulative loss rate. Two guards keep one default from
 *      stopping everyone: the ratio applies only once `minOriginated` has
 *      been lent (on a young pool one loss is a large share), and the owner
 *      can acknowledge the bad debt so far (`acknowledgeBadDebt`), after which
 *      only new losses count. Neither touches the depeg or stale-price checks.
 *
 *      Freshness. A report is refused when it is out of order (not newer than
 *      the latest), from more than MAX_CLOCK_SKEW in the future, or already
 *      older than `maxAttestationAge`. Past `maxAttestationAge` the latest
 *      attestation is stale and its price reasons FAIL OPEN: a guardian that
 *      stopped reporting (a simulate-only setup runs nothing on a schedule)
 *      must not lock Pay in 4. The pool reasons still apply.
 *
 *      Owner override: `setOverride(ForcePause, 0)` pauses credit whatever
 *      the guard says (reason REASON_OWNER_PAUSE) until set back.
 *      `setOverride(ForceResume, until)` opens it whatever the guard says,
 *      but only until `until`, at most MAX_FORCE_RESUME ahead, so a forgotten
 *      resume cannot outlive a later depeg. `setOverride(None, 0)` follows
 *      the guard again. Each is an event.
 *
 *      Pool health as a feed. This contract is an AggregatorV3Interface, so an
 *      app or contract that reads Chainlink feeds reads it the same way:
 *      description "Polaris pool health, computed by CRE", 8 decimals. Each
 *      accepted attestation is a round, and its answer is what the pool can
 *      lend at that moment, in US dollars: the pool's free cash when the
 *      report landed (read from the pool, not the report), valued at the
 *      attested AUSD/USD price, or 0 when the verdict paused credit. startedAt
 *      and updatedAt are the attestation's `observedAt`. A round never changes
 *      after it is written, so an owner override or staleness is not in it;
 *      `creditStatus()` has those. It is a Polaris attestation computed by a
 *      CRE workflow, not a Chainlink Data Feed or Proof of Reserve.
 */
contract GuardianReceiver is PolarisReceiver, AggregatorV3Interface, ICreditGuard {
    uint8 public constant REPORT_KIND = 3;
    /// Decimals of the AUSD/USD answer the report carries, and of this feed.
    uint8 public constant PRICE_DECIMALS = 8;

    uint8 public constant REASON_DEPEG = 1;
    uint8 public constant REASON_LOW_CASH = 2;
    uint8 public constant REASON_BAD_DEBT = 4;
    uint8 public constant REASON_STALE_PRICE = 8;
    /// Only in `isCreditPaused` / `creditStatus`: the owner forced a pause.
    uint8 public constant REASON_OWNER_PAUSE = 0x80;
    /// The reasons taken from the attestation (the cross-chain price).
    uint8 public constant PRICE_REASONS = REASON_DEPEG | REASON_STALE_PRICE;
    /// The reasons read from the pool itself, live.
    uint8 public constant POOL_REASONS = REASON_LOW_CASH | REASON_BAD_DEBT;

    /// How far past the block an observation may be dated (DON and chain clocks).
    uint32 public constant MAX_CLOCK_SKEW = 5 minutes;
    /// Longest `maxAttestationAge` the owner may set.
    uint32 public constant MAX_ATTESTATION_AGE_LIMIT = 7 days;
    /// Longest a forced resume may last.
    uint32 public constant MAX_FORCE_RESUME = 1 days;
    /// Highest `maxPrice` the owner may set: $2, PRICE_DECIMALS decimals.
    int256 public constant PRICE_CEILING = 2 * 10 ** 8;

    enum Override {
        None,
        ForceResume,
        ForcePause
    }

    /// One CRE observation of the pool and the peg, and the workflow's verdict.
    struct Attestation {
        /// The AUSD/USD round cited, on Monad mainnet.
        uint80 priceRoundId;
        /// That round's answer, PRICE_DECIMALS decimals.
        int256 price;
        /// That round's updatedAt.
        uint64 priceUpdatedAt;
        /// PolarisLoanEngine.poolState() at observedAt, stablecoin base units.
        uint256 freeCash;
        uint256 totalOwed;
        uint256 badDebt;
        uint256 totalOriginated;
        /// When the DON observed the above, unix seconds.
        uint64 observedAt;
        bool creditPaused;
        uint8 reasons;
    }

    /// The policy. Defaults: decision 9 ($0.995, $1,000, 5%, 2 hours), a
    /// $1.005 ceiling, and the bad-debt ratio from $10,000 lent.
    struct Thresholds {
        /// Lowest AUSD/USD price that is not a depeg, PRICE_DECIMALS decimals.
        int256 minPrice;
        /// Highest AUSD/USD price that is not a depeg (an upward break, or a
        /// faulty answer), PRICE_DECIMALS decimals; at most PRICE_CEILING.
        int256 maxPrice;
        /// Least free pool cash, stablecoin base units.
        uint256 minFreeCash;
        /// Most bad debt, in basis points of lifetime originations.
        uint16 maxBadDebtBps;
        /// Lifetime originations, stablecoin base units, below which the
        /// bad-debt ratio is not applied: on a young pool one loss is a large share.
        uint256 minOriginated;
        /// Oldest the cited price may be at observation, seconds.
        uint32 maxPriceAge;
    }

    /// Everything a client needs to show the guard, in one read.
    struct CreditStatus {
        /// What PolarisCheckout.openPlan applies now.
        bool paused;
        /// Why it is paused (0 when open).
        uint8 reasons;
        /// The latest attestation's own verdict.
        bool attestedPaused;
        uint8 attestedReasons;
        /// The latest attestation's observedAt; 0 when there is none.
        uint64 observedAt;
        /// No attestation, or older than maxAttestationAge: the price reasons fail open.
        bool stale;
        /// The override in force now (a forced resume past its end reads None).
        Override overrideMode;
        uint32 maxAttestationAge;
        /// Rounds written so far (the feed's latest round id).
        uint80 round;
        /// When the forced resume in force ends; 0 when there is none.
        uint64 overrideUntil;
        /// Low cash and bad debt, from the pool now (never stale).
        uint8 poolReasons;
        /// Depeg and stale price, from the latest attestation under today's
        /// thresholds; 0 once it is stale.
        uint8 priceReasons;
        /// Bad debt the owner acknowledged; only bad debt beyond it counts.
        uint256 badDebtAcknowledged;
    }

    /// A feed round, packed in one slot.
    struct Round {
        int192 answer;
        uint64 observedAt;
    }

    IPolarisPool public immutable pool;
    /// 10 ** the pool stablecoin's decimals, to value free cash in dollars.
    uint256 public immutable cashScale;

    Thresholds private _thresholds;
    /// Past this age the latest attestation is stale and its price reasons fail open.
    uint32 public maxAttestationAge;
    /// The override as set; `activeOverride()` is the one in force.
    Override public overrideMode;
    /// When a forced resume ends (unix seconds); 0 for the other modes.
    uint64 public overrideUntil;
    /// Bad debt the owner acknowledged (`acknowledgeBadDebt`), stablecoin base units.
    uint256 public badDebtAcknowledged;

    Attestation private _latest;
    uint80 public latestRound;
    mapping(uint80 => Round) private _rounds;

    /// An attestation was accepted and is now the latest. `round` is the feed round it wrote.
    event CreditGuardUpdated(uint80 indexed round, bool indexed creditPaused, uint8 reasons, Attestation attestation);
    /// A report was well formed but refused; `reason` is one of the errors below. Nothing changed.
    event AttestationRefused(uint64 observedAt, bytes reason);
    event ThresholdsSet(Thresholds thresholds);
    event MaxAttestationAgeSet(uint32 maxAttestationAge);
    event CreditGuardOverridden(Override mode, uint64 until);
    event BadDebtAcknowledged(uint256 badDebt);

    error ZeroAddress();
    error InvalidThresholds();
    error InvalidMaxAttestationAge(uint32 maxAttestationAge);
    error InvalidOverride(Override mode, uint64 until);
    error RoundNotFound(uint80 roundId);
    /// Refusals, delivered as `AttestationRefused.reason`.
    error ObservationInFuture(uint64 observedAt, uint256 blockTimestamp);
    error AttestationOutOfOrder(uint64 observedAt, uint64 latestObservedAt);
    error AttestationTooOld(uint64 observedAt, uint32 maxAttestationAge);
    error VerdictMismatch(bool reportedPaused, uint8 reportedReasons, uint8 computedReasons);
    /// The report's low-cash and bad-debt verdict is not the live pool's.
    error PoolMismatch(uint8 reportedPoolReasons, uint8 livePoolReasons);

    constructor(
        address forwarder,
        IPolarisPool _pool,
        address _simulationTransmitter,
        Thresholds memory thresholds_,
        uint32 _maxAttestationAge
    ) PolarisReceiver(forwarder, _simulationTransmitter) {
        if (address(_pool) == address(0)) revert ZeroAddress();
        pool = _pool;
        cashScale = 10 ** IERC20Metadata(_pool.stablecoin()).decimals();
        _setThresholds(thresholds_);
        _setMaxAttestationAge(_maxAttestationAge);
    }

    // -----------------------------------------------------------------
    // Owner
    // -----------------------------------------------------------------

    function setThresholds(Thresholds calldata t) external onlyOwner {
        _setThresholds(t);
    }

    function setMaxAttestationAge(uint32 age) external onlyOwner {
        _setMaxAttestationAge(age);
    }

    /**
     * @notice Force credit paused (`until` 0) or open (`until` in the next
     *         MAX_FORCE_RESUME) whatever the guard says, or (None, `until` 0)
     *         follow the guard again.
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
     *         debt beyond it counts toward REASON_BAD_DEBT. For a pause the
     *         owner has looked into; it leaves every other reason alone.
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
        Thresholds memory t = _thresholds;
        reasons = _poolReasons(pool.poolState(), t);
        if (!isStale()) reasons |= _priceReasons(_latest, t);
        paused = reasons != 0;
    }

    /// @notice The override in force now: a forced resume past `overrideUntil` is None.
    function activeOverride() public view returns (Override) {
        Override mode = overrideMode;
        if (mode == Override.ForceResume && block.timestamp >= overrideUntil) return Override.None;
        return mode;
    }

    /// @notice True when there is no attestation or the latest is older than
    ///         `maxAttestationAge`: its price reasons then fail open.
    function isStale() public view returns (bool) {
        uint64 observedAt = _latest.observedAt;
        return observedAt == 0 || block.timestamp > uint256(observedAt) + maxAttestationAge;
    }

    function creditStatus() external view returns (CreditStatus memory s) {
        (s.paused, s.reasons) = isCreditPaused();
        s.attestedPaused = _latest.creditPaused;
        s.attestedReasons = _latest.reasons;
        s.observedAt = _latest.observedAt;
        s.stale = isStale();
        s.overrideMode = activeOverride();
        s.maxAttestationAge = maxAttestationAge;
        s.round = latestRound;
        s.overrideUntil = s.overrideMode == Override.ForceResume ? overrideUntil : 0;
        Thresholds memory t = _thresholds;
        s.poolReasons = _poolReasons(pool.poolState(), t);
        s.priceReasons = s.stale ? 0 : _priceReasons(_latest, t);
        s.badDebtAcknowledged = badDebtAcknowledged;
    }

    function latestAttestation() external view returns (Attestation memory) {
        return _latest;
    }

    function thresholds() external view returns (Thresholds memory) {
        return _thresholds;
    }

    /// @notice The workflow's one read on the pool's chain: the engine's pool
    ///         state now, the thresholds to judge it by, and the bad debt the
    ///         owner acknowledged.
    function currentInputs()
        external
        view
        returns (IPolarisPool.PoolState memory state, Thresholds memory limits, uint256 acknowledgedBadDebt)
    {
        return (pool.poolState(), _thresholds, badDebtAcknowledged);
    }

    /**
     * @notice The verdict for `a` under the current thresholds and the bad
     *         debt acknowledged: the reason bits, 0 when healthy. The
     *         workflow's `reasons` must equal it.
     */
    function evaluate(Attestation memory a) public view returns (uint8 reasons) {
        Thresholds memory t = _thresholds;
        IPolarisPool.PoolState memory s = IPolarisPool.PoolState({
            freeCash: a.freeCash,
            totalOwed: a.totalOwed,
            badDebt: a.badDebt,
            totalOriginated: a.totalOriginated
        });
        return _poolReasons(s, t) | _priceReasons(a, t);
    }

    // -----------------------------------------------------------------
    // AggregatorV3Interface: pool health as a feed
    // -----------------------------------------------------------------

    function decimals() external pure returns (uint8) {
        return PRICE_DECIMALS;
    }

    function description() external pure returns (string memory) {
        return "Polaris pool health, computed by CRE";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (roundId == 0 || roundId > latestRound) revert RoundNotFound(roundId);
        Round memory r = _rounds[roundId];
        return (roundId, r.answer, r.observedAt, r.observedAt, roundId);
    }

    /// @dev All zeros before the first attestation, as a new Chainlink aggregator reads.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        roundId = latestRound;
        if (roundId == 0) return (0, 0, 0, 0, 0);
        Round memory r = _rounds[roundId];
        return (roundId, r.answer, r.observedAt, r.observedAt, roundId);
    }

    // -----------------------------------------------------------------
    // Reports
    // -----------------------------------------------------------------

    function _processReport(bytes calldata report) internal override {
        _checkDelivery();
        _requireKind(report, REPORT_KIND);
        (, Attestation memory a) = abi.decode(report, (uint8, Attestation));

        IPolarisPool.PoolState memory live = pool.poolState();
        bytes memory refusal = _refusal(a, live);
        if (refusal.length != 0) {
            emit AttestationRefused(a.observedAt, refusal);
            return;
        }

        _latest = a;
        uint80 round = latestRound + 1;
        latestRound = round;
        _rounds[round] = Round({answer: _lendableUsd(a, live.freeCash), observedAt: a.observedAt});
        emit CreditGuardUpdated(round, a.creditPaused, a.reasons, a);
    }

    /// Why `a` can't be accepted, as an encoded error; empty when it can.
    function _refusal(Attestation memory a, IPolarisPool.PoolState memory live) private view returns (bytes memory) {
        if (a.observedAt > block.timestamp + MAX_CLOCK_SKEW) {
            return abi.encodeWithSelector(ObservationInFuture.selector, a.observedAt, block.timestamp);
        }
        uint64 latest = _latest.observedAt;
        if (a.observedAt <= latest) {
            return abi.encodeWithSelector(AttestationOutOfOrder.selector, a.observedAt, latest);
        }
        if (block.timestamp > uint256(a.observedAt) + maxAttestationAge) {
            return abi.encodeWithSelector(AttestationTooOld.selector, a.observedAt, maxAttestationAge);
        }
        uint8 computed = evaluate(a);
        if (a.reasons != computed || a.creditPaused != (computed != 0)) {
            return abi.encodeWithSelector(VerdictMismatch.selector, a.creditPaused, a.reasons, computed);
        }
        uint8 livePool = _poolReasons(live, _thresholds);
        if ((computed & POOL_REASONS) != livePool) {
            return abi.encodeWithSelector(PoolMismatch.selector, computed & POOL_REASONS, livePool);
        }
        return "";
    }

    /// Low cash and bad debt for pool state `s` under `t`.
    function _poolReasons(IPolarisPool.PoolState memory s, Thresholds memory t) private view returns (uint8 reasons) {
        if (s.freeCash < t.minFreeCash) reasons |= REASON_LOW_CASH;
        if (s.totalOriginated >= t.minOriginated) {
            uint256 acknowledged = badDebtAcknowledged;
            uint256 unacknowledged = s.badDebt > acknowledged ? s.badDebt - acknowledged : 0;
            // unacknowledged / totalOriginated > maxBadDebtBps / 10_000, exactly
            // (bad debt is an integer, so comparing it to the floored limit is exact).
            if (unacknowledged > Math.mulDiv(s.totalOriginated, t.maxBadDebtBps, 10_000)) reasons |= REASON_BAD_DEBT;
        }
    }

    /// Depeg and stale price for the attested round under `t`.
    function _priceReasons(Attestation memory a, Thresholds memory t) private pure returns (uint8 reasons) {
        if (a.price < t.minPrice || a.price > t.maxPrice) reasons |= REASON_DEPEG;
        if (a.priceUpdatedAt == 0 || (a.observedAt > a.priceUpdatedAt && a.observedAt - a.priceUpdatedAt > t.maxPriceAge)) {
            reasons |= REASON_STALE_PRICE;
        }
    }

    /// The feed's answer: `freeCash` in dollars (PRICE_DECIMALS) at the
    /// attested price, or 0 when the attestation paused credit. Saturates at
    /// int192's maximum, so no balance can make a round write revert.
    function _lendableUsd(Attestation memory a, uint256 freeCash) private view returns (int192) {
        // Not paused, so minPrice <= price <= maxPrice <= PRICE_CEILING, and price > 0.
        if (a.creditPaused) return 0;
        (bool ok, uint256 product) = Math.tryMul(freeCash, uint256(a.price));
        uint256 usd = ok ? product / cashScale : type(uint256).max;
        uint256 cap = uint256(uint192(type(int192).max));
        return usd > cap ? type(int192).max : int192(int256(usd));
    }

    function _setThresholds(Thresholds memory t) private {
        if (
            t.minPrice <= 0 || t.maxPrice < t.minPrice || t.maxPrice > PRICE_CEILING || t.maxBadDebtBps > 10_000 || t.maxPriceAge == 0
        ) {
            revert InvalidThresholds();
        }
        _thresholds = t;
        emit ThresholdsSet(t);
    }

    function _setMaxAttestationAge(uint32 age) private {
        if (age == 0 || age > MAX_ATTESTATION_AGE_LIMIT) revert InvalidMaxAttestationAge(age);
        maxAttestationAge = age;
        emit MaxAttestationAgeSet(age);
    }
}

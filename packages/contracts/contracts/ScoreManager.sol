// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface ICollateralBoost {
    function creditBoostOf(address user) external view returns (uint256);
    function lockedOf(address user) external view returns (uint256);
}

/**
 * @title ScoreManager
 * @notice FICO-style credit scores (300-850) driven by on-chain repayment
 *         behaviour. The score sets how much a borrower may draw.
 *
 * @dev Scores move on facts the protocol observes itself -- an installment
 *      paid on time, an installment paid late, a liquidation -- so credit
 *      history is earned rather than attested. Only registered writers (the
 *      LoanEngine) may record those events.
 *
 *      The one exception is the first line, which has no repayment history to
 *      read. `underwrite` takes facts about the wallet's life elsewhere, as
 *      attested by the Chainlink DON, and computes the opening score here, in
 *      `scoreFromFacts`. The facts are attested; the score never is. Anyone can
 *      re-derive a borrower's opening score from the report that produced it,
 *      and nobody, including us, can hand a wallet a number the formula would
 *      not give it.
 *
 *      The two kinds of write are two roles. A writer records repayment
 *      events; an underwriter (the receiver that verifies DON reports) opens
 *      first lines. Sharing one role meant the receiver could also call
 *      `recordOnTimePayment` for any wallet and lift it past the $1,000
 *      underwriting cap, so a bug in the receiver became unlimited credit.
 *      Split, neither key can do the other's job.
 *
 *      The on-time bonus is rationed here, not in the engine: one clock per
 *      wallet, whatever the number of writers. Kept per engine, every writer
 *      paid its own weekly bonus and a redeploy reset everyone's ration, and
 *      underwriting could not start the clock. See `recordOnTimeInstallment`.
 */
contract ScoreManager is Ownable {
    uint16 public constant MIN_SCORE = 300;
    uint16 public constant MAX_SCORE = 850;
    uint16 public constant STARTING_SCORE = 600;

    // Deliberately asymmetric: trust is slow to earn and fast to lose, which
    // is both how real credit bureaus behave and the correct bias for an
    // undercollateralized book.
    uint16 public constant ON_TIME_BONUS = 12;
    uint16 public constant LATE_PENALTY = 40;
    uint16 public constant DEFAULT_PENALTY = 150;

    /// Where the score starts before facts lift it by earning points or sink
    /// it with penalties: the floor tier. A report that earns nothing opens
    /// nothing, though: it must first show a history (`isThinFile`).
    uint16 public constant UNDERWRITE_FLOOR = 520;
    /// The highest score underwriting can assign. 739 is the top of the $1,000
    /// tier, so an underwritten line never opens above $1,000; 740 and up is
    /// reached only by repaying.
    uint16 public constant MAX_UNDERWRITTEN_SCORE = 739;
    /// How old the facts behind an underwriting report may be. Long enough for
    /// a DON round and a relayed transaction, short enough that a report cannot
    /// be held back and replayed after the wallet's history has turned.
    uint256 public constant MAX_EVIDENCE_AGE = 15 minutes;

    /// The most each signal in `scoreFromFacts` can earn. Public so the
    /// ceiling argument can be checked rather than trusted: the floor plus
    /// every cap must stay at or under MAX_UNDERWRITTEN_SCORE.
    uint16 public constant MAX_AGE_POINTS = 60;
    uint16 public constant MAX_ACTIVITY_POINTS = 50;
    uint16 public constant MAX_BALANCE_POINTS = 50;
    uint16 public constant MAX_DEFI_POINTS = 30;
    uint16 public constant EXCHANGE_FUNDED_POINTS = 10;

    /// How many liquidations close a wallet's unsecured line for good. The
    /// same count declines a report in `scoreFromFacts`, so a default on
    /// Polaris weighs at least as much as one the DON attests elsewhere.
    uint32 public constant DECLINE_AT_LIQUIDATIONS = 2;

    /// The least history a report must show before it opens any unsecured
    /// line: this many days since the buyer's oldest activity (the account
    /// or the wallet it linked) ... See `isThinFile`.
    uint32 public constant MIN_HISTORY_DAYS = 90;
    /// ... and this many transactions across them.
    uint32 public constant MIN_HISTORY_TXS = 10;

    /**
     * @notice The least time between two on-time bonuses for one wallet,
     *         measured on the schedule rather than the clock.
     * @dev A wallet that can earn a bonus per call reaches 850 with a dust plan
     *      prepaid a unit at a time, or twenty plans paid at once: no rule
     *      about a single instalment stops a farmer who opens many. What a
     *      farmer cannot parallelise is time, so bonuses are at most one a
     *      week, the way a bureau reads a monthly statement rather than every
     *      card swipe. See `recordOnTimeInstallment` for which moment counts.
     */
    uint256 public constant BONUS_PERIOD = 7 days;

    struct Profile {
        uint16 score;
        uint32 onTimePayments;
        uint32 latePayments;
        uint32 liquidations;
        uint64 firstSeenAt;
        bool initialized;
        /// Set by underwriting when a fact disqualifies the wallet outright,
        /// and by a wallet's DECLINE_AT_LIQUIDATIONS-th liquidation here. A
        /// declined wallet gets no unsecured line; collateral still works, at
        /// face value.
        bool declined;
        /// Set only by `underwrite`. `initialized` says the wallet has a
        /// record; this says the DON has looked at it. While
        /// `requireUnderwriting` is on, only this opens an unsecured line.
        bool underwritten;
    }

    /**
     * @notice What the Chainlink DON attests about a wallet's life elsewhere.
     * @dev Raw observations only, never a score or a verdict, so the contract
     *      keeps the whole decision. `stableBalance` is in 6-decimal base units.
     *      `observedAt` is when the facts were read, which is what staleness is
     *      measured from.
     */
    struct Facts {
        uint32 walletAgeDays;
        uint32 txCount;
        uint64 stableBalance;
        uint32 defiTenureDays;
        uint16 priorLiquidations;
        uint16 relatedWallets;
        bool exchangeFunded;
        uint64 observedAt;
    }

    mapping(address => Profile) private _profiles;
    /// May record repayment events. The LoanEngine.
    mapping(address => bool) public isWriter;
    /// May open a first line from attested facts. The DON report receiver.
    mapping(address => bool) public isUnderwriter;
    /// The moment each wallet's last on-time bonus counts from, or its report
    /// if that is later. See BONUS_PERIOD.
    mapping(address => uint64) public lastBonusAt;

    /// Optional. Unset means the protocol runs as pure credit, no collateral.
    ICollateralBoost public collateralVault;

    /**
     * @notice When true, no wallet gets an unsecured line until it has been
     *         underwritten.
     * @dev Off by default so a deployment behaves as it always has: a stranger
     *      reads at STARTING_SCORE and may borrow the tier that implies. On
     *      Monad that default is a faucet, since a fresh Face ID account costs
     *      nothing to create, so the deployment turns this on and every
     *      unsecured line starts from an underwriting report instead.
     *
     *      "Has a record" is not the same as "was underwritten". Every record
     *      starts life at STARTING_SCORE, whether it was created by an on-time
     *      payment, a late one or a liquidation, so gating on the record let a
     *      wallet skip the DON by repaying a dust plan on the secured path, and
     *      a secured-path default opened a $200 line a clean stranger could not
     *      get. The gate reads `underwritten`, which only `underwrite` sets.
     *      History earned on the secured path is not thrown away: on-time and
     *      late payments alike are folded into the opening score when the
     *      wallet is underwritten.
     *
     *      Nor does the secured path lend unsecured by the back door. The
     *      vault's multiplier (150% by default) means a third of a secured line
     *      is credit no collateral covers, so a fresh account could lock X,
     *      borrow 1.5X and walk away. A wallet with no unsecured line of its
     *      own -- not yet underwritten while this is on, or declined -- borrows
     *      against its collateral at face value, so a default is always
     *      recoverable in full. See `creditLimitOf`.
     */
    bool public requireUnderwriting;

    event ScoreChanged(address indexed user, uint16 oldScore, uint16 newScore, string reason);
    event WriterSet(address indexed writer, bool allowed);
    event UnderwriterSet(address indexed underwriter, bool allowed);
    event CollateralVaultSet(address indexed vault);
    event Underwritten(address indexed user, uint16 score, bool declined, uint64 observedAt);
    event RequireUnderwritingSet(bool required);
    /// A wallet's liquidations here reached DECLINE_AT_LIQUIDATIONS and its
    /// unsecured line closed. The app reads this to explain a limit of zero.
    event DeclinedForDefaults(address indexed user, uint32 liquidations);

    error VaultNotAContract(address vault);

    error NotWriter();
    error NotUnderwriter();
    error AlreadyHasRecord();
    error StaleEvidence();
    /// The report shows too little history to open an unsecured line. See
    /// `isThinFile`. Nothing is recorded, so a later report with a linked
    /// history wallet can still open one.
    error ThinFile(uint32 walletAgeDays, uint32 txCount);

    modifier onlyWriter() {
        if (!isWriter[msg.sender]) revert NotWriter();
        _;
    }

    modifier onlyUnderwriter() {
        if (!isUnderwriter[msg.sender]) revert NotUnderwriter();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setWriter(address writer, bool allowed) external onlyOwner {
        isWriter[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    function setUnderwriter(address underwriter, bool allowed) external onlyOwner {
        isUnderwriter[underwriter] = allowed;
        emit UnderwriterSet(underwriter, allowed);
    }

    /**
     * @notice Point at the collateral vault, or clear it with the zero address.
     * @dev Rejects an address with no code. `creditLimitOf` wraps the vault call
     *      in try/catch so a misbehaving vault degrades to "no boost" rather
     *      than reverting every loan in the protocol, and that holds for a
     *      contract with the wrong ABI. It does NOT hold for an address with no
     *      code at all: the return-data decode failure is not catchable in
     *      Solidity, so `creditLimitOf` reverts, and since `createLoan` calls it
     *      on every origination, one owner typo bricks lending for every
     *      borrower. Cheaper to refuse the address than to discover that later.
     */
    function setCollateralVault(ICollateralBoost vault) external onlyOwner {
        if (address(vault) != address(0) && address(vault).code.length == 0) {
            revert VaultNotAContract(address(vault));
        }
        collateralVault = vault;
        emit CollateralVaultSet(address(vault));
    }

    /// @notice Require an underwriting report before any unsecured line
    ///         opens. See `requireUnderwriting`.
    function setRequireUnderwriting(bool required) external onlyOwner {
        requireUnderwriting = required;
        emit RequireUnderwritingSet(required);
    }

    /// @notice Score for a user, seeding a fresh profile at STARTING_SCORE.
    function scoreOf(address user) public view returns (uint16) {
        Profile storage p = _profiles[user];
        return p.initialized ? p.score : STARTING_SCORE;
    }

    function profileOf(address user) external view returns (Profile memory) {
        Profile memory p = _profiles[user];
        if (!p.initialized) {
            p.score = STARTING_SCORE;
        }
        return p;
    }

    /**
     * @notice Credit limit from score alone, in stablecoin base units.
     * @dev Piecewise rather than linear so the jumps are legible to a user
     *      ("get to 700 and your limit doubles") instead of a smooth curve
     *      nobody can reason about.
     *
     *      Zero, whatever the score, for a declined wallet (by its report, or by
     *      defaulting here DECLINE_AT_LIQUIDATIONS times), and, while
     *      `requireUnderwriting` is on, for any wallet not yet underwritten,
     *      however its record came about. Both still reach their collateral
     *      through `creditLimitOf`, so the secured path stays open to them.
     */
    function baseLimitOf(address user) public view returns (uint256) {
        Profile storage p = _profiles[user];
        if (_securedOnly(p)) return 0;

        uint16 s = p.initialized ? p.score : STARTING_SCORE;
        if (s >= 800) return 5_000e6;
        if (s >= 740) return 2_500e6;
        if (s >= 670) return 1_000e6;
        if (s >= 580) return 500e6;
        return 200e6;
    }

    /**
     * @notice The limit a borrower can actually draw: score plus any boost
     *         earned by locking collateral.
     *
     * @dev This is the single number the LoanEngine, the checkout SDK and both
     *      UIs read, so a borrower is never shown one limit and refused at
     *      another. The vault is optional -- with none configured this is
     *      exactly the score-derived limit, which is the pure credit product.
     *
     *      A failing vault call must not brick origination, so the boost is
     *      read defensively: an unreachable or misbehaving vault degrades to
     *      "no boost" rather than reverting every loan in the protocol.
     *
     *      A wallet with no unsecured line of its own (see `_securedOnly`) gets
     *      at most the collateral's face value. The multiplier's extra half is
     *      credit nothing secures, and for these wallets nobody has assessed
     *      it: a never-underwritten account locked X, borrowed 1.5X, walked away
     *      and left a third as bad debt, from as many fresh accounts as it
     *      liked. At face value, everything owed, interest included, fits
     *      inside what liquidation can seize. An underwritten wallet keeps the
     *      full multiplier on top of the line its report opened.
     */
    function creditLimitOf(address user) external view returns (uint256) {
        uint256 base = baseLimitOf(user);
        if (address(collateralVault) == address(0)) {
            return base;
        }
        uint256 boost;
        try collateralVault.creditBoostOf(user) returns (uint256 b) {
            boost = b;
        } catch {
            return base;
        }
        if (_securedOnly(_profiles[user])) {
            try collateralVault.lockedOf(user) returns (uint256 locked) {
                if (boost > locked) boost = locked;
            } catch {
                // Face value unknown: lend nothing rather than guess.
                boost = 0;
            }
        }
        return base + boost;
    }

    /// No unsecured line: declined, or not yet underwritten while underwriting
    /// is required. Such a wallet borrows only against collateral, at face value.
    function _securedOnly(Profile storage p) private view returns (bool) {
        return p.declined || (requireUnderwriting && !p.underwritten);
    }

    // -----------------------------------------------------------------
    // Underwriting -- the first line
    // -----------------------------------------------------------------

    /**
     * @notice The opening score a set of facts earns, and whether they
     *         disqualify the wallet outright.
     * @dev Public and pure so the formula is the specification: the off-chain
     *      mirror, the app's explanation of a limit, and an auditor re-deriving
     *      a decision all call or copy this one function.
     *
     *      Every signal is capped, so no single one can carry an approval, and
     *      a missing data source (a zero) neither rewards nor punishes. The
     *      floor plus every cap is 720, under MAX_UNDERWRITTEN_SCORE, so no
     *      input reaches the ceiling clamp today. It stays anyway, so that
     *      retuning a weight can never open a line above $1,000, and the caps
     *      are public constants so a test can hold that sum under the ceiling.
     *
     *      Arithmetic runs in uint256 and int256 on values widened from at most
     *      64 bits, so no input can overflow: the largest possible penalty,
     *      65,535 liquidations plus the full cluster penalty, is under 5
     *      million.
     *
     *      Two facts decline on their own, whatever the total. Two or more
     *      prior liquidations is a different product, not a pricing problem.
     *      Twenty-five or more wallets funded from the same source is one
     *      borrower asking for many credit lines.
     */
    function scoreFromFacts(Facts calldata f) public pure returns (uint16 score, bool declined) {
        uint256 age = _min((uint256(f.walletAgeDays) / 30) * 2, MAX_AGE_POINTS);
        uint256 activity = _min(uint256(f.txCount) / 25, MAX_ACTIVITY_POINTS);
        uint256 balance = _min(uint256(f.stableBalance) / 100e6, MAX_BALANCE_POINTS);
        uint256 defi = _min(uint256(f.defiTenureDays) / 30, MAX_DEFI_POINTS);
        uint256 funding = f.exchangeFunded ? EXCHANGE_FUNDED_POINTS : 0;

        uint256 cluster = f.relatedWallets > 3
            ? _min((uint256(f.relatedWallets) - 3) * 2, 80)
            : 0;
        uint256 penalty = uint256(f.priorLiquidations) * 75 + cluster;

        int256 raw = int256(uint256(UNDERWRITE_FLOOR) + age + activity + balance + defi + funding) -
            int256(penalty);
        if (raw < int256(uint256(MIN_SCORE))) raw = int256(uint256(MIN_SCORE));
        if (raw > int256(uint256(MAX_UNDERWRITTEN_SCORE))) {
            raw = int256(uint256(MAX_UNDERWRITTEN_SCORE));
        }

        score = uint16(uint256(raw));
        declined = f.priorLiquidations >= DECLINE_AT_LIQUIDATIONS || f.relatedWallets >= 25;
    }

    /**
     * @notice Whether a report shows too little history to open an unsecured
     *         line: younger than MIN_HISTORY_DAYS, or fewer than
     *         MIN_HISTORY_TXS transactions.
     * @dev The floor score is not a reward for showing up. `scoreFromFacts`
     *      gives facts that are all zero UNDERWRITE_FLOOR, and 520 reads as the
     *      $200 tier, so a report about a Face ID account created a minute ago
     *      opened $200 of unsecured credit. Accounts cost nothing to create,
     *      so one person could open as many lines as they cared to make
     *      accounts, spend each at a merchant of their own, and never repay:
     *      with nothing locked, liquidation seizes nothing. The sybil checks
     *      (`relatedWallets`, one history per line) only bite on a history
     *      that exists.
     *
     *      So a report must show a life elsewhere before it opens anything:
     *      at least MIN_HISTORY_DAYS since the oldest activity and at least
     *      MIN_HISTORY_TXS transactions, over the account and the wallet it
     *      linked. Age is the signal a farmer cannot parallelise; the
     *      transaction floor stops an old wallet that was funded once and
     *      never used from standing in for a history. The balance does not
     *      count here, since the same dollars can be moved from account to
     *      account ahead of each report.
     *
     *      A thin file is refused, not declined: `underwrite` records nothing,
     *      so the buyer can still bring a history wallet later, and until then
     *      borrows against collateral at face value (see `creditLimitOf`).
     *      Kept out of `scoreFromFacts` so the score, and every mirror of it,
     *      is unchanged; the off-chain decision must apply this too.
     */
    function isThinFile(Facts calldata f) public pure returns (bool) {
        return f.walletAgeDays < MIN_HISTORY_DAYS || f.txCount < MIN_HISTORY_TXS;
    }

    /**
     * @notice Open a wallet's first line from attested facts.
     * @dev Underwriter-only: the receiver that verifies the DON's report calls
     *      this.
     *
     *      Runs once per wallet, and never over a record that holds a
     *      liquidation. If it could, a borrower who defaulted could fetch a
     *      fresh report of a clean-looking wallet and have the liquidation
     *      written over: a bad record laundered through an oracle. While
     *      `requireUnderwriting` is off it also refuses any record at all,
     *      since that record already gives the wallet a line and underwriting
     *      is for the cold start only.
     *
     *      While underwriting is required it accepts one more kind of record: a
     *      wallet never underwritten, with no liquidation, whose history is
     *      on-time and late payments on the secured path. Such a wallet has no
     *      unsecured line, and refusing it would leave it without one for good.
     *      Refusing a late mark too turned a -40 into a lifetime ban, and the
     *      timing of that mark is in the relayer's and the keeper's hands, not
     *      the borrower's. So the history is folded in instead: what the
     *      secured path moved the score by, up or down, is added to what the
     *      facts give, the same number the wallet would hold had the report
     *      come first. A penalty carries into the opening score, so nothing is
     *      laundered, and the sum is still capped at MAX_UNDERWRITTEN_SCORE, so
     *      however much secured history came first, a report never opens a
     *      line above $1,000.
     *
     *      The report starts the bonus clock. Otherwise a wallet whose last
     *      bonus was a week ago could underwrite at the top of the $1,000 tier
     *      and cross into $2,500 with a plan opened and repaid in the next
     *      transaction: the cap would last one block. From the report, the
     *      first bonus waits a full BONUS_PERIOD.
     *
     *      Refuses facts observed more than MAX_EVIDENCE_AGE ago, or stamped in
     *      the future. An old report is a snapshot of a wallet that may since
     *      have been drained or liquidated elsewhere, and a future stamp would
     *      let a report be pre-dated to outlive the window.
     *
     *      Refuses a thin file (`isThinFile`) with `ThinFile`, recording
     *      nothing, unless the facts decline the wallet outright: a decline is
     *      recorded whatever the history, so a thin file can't be used to dodge
     *      one.
     */
    function underwrite(address user, Facts calldata f)
        external
        onlyUnderwriter
        returns (uint16 score)
    {
        Profile storage p = _profiles[user];
        if (p.initialized && (p.underwritten || !requireUnderwriting || p.liquidations != 0)) {
            revert AlreadyHasRecord();
        }
        if (f.observedAt > block.timestamp || block.timestamp - f.observedAt > MAX_EVIDENCE_AGE) {
            revert StaleEvidence();
        }

        bool declined;
        (score, declined) = scoreFromFacts(f);
        if (!declined && isThinFile(f)) revert ThinFile(f.walletAgeDays, f.txCount);

        uint16 old = STARTING_SCORE;
        if (p.initialized) {
            // Secured-path history, signed: every record starts at
            // STARTING_SCORE, so the difference is exactly what its payments
            // earned and cost.
            old = p.score;
            int256 folded = int256(uint256(score)) + int256(uint256(old)) -
                int256(uint256(STARTING_SCORE));
            if (folded < int256(uint256(MIN_SCORE))) folded = int256(uint256(MIN_SCORE));
            if (folded > int256(uint256(MAX_UNDERWRITTEN_SCORE))) {
                folded = int256(uint256(MAX_UNDERWRITTEN_SCORE));
            }
            score = uint16(uint256(folded));
        } else {
            p.initialized = true;
            p.firstSeenAt = uint64(block.timestamp);
        }

        p.score = score;
        p.declined = declined;
        p.underwritten = true;
        lastBonusAt[user] = uint64(block.timestamp);

        emit Underwritten(user, score, declined, f.observedAt);
        emit ScoreChanged(user, old, score, "underwritten");
    }

    // -----------------------------------------------------------------
    // Repayment history -- what the LoanEngine records
    // -----------------------------------------------------------------

    /**
     * @notice Record an instalment paid on time, and pay its bonus if the
     *         wallet's ration allows. Returns whether the score moved.
     * @dev What the LoanEngine calls. `dueAt` is when the instalment fell due.
     *
     *      The ration is measured on the schedule, not on the block. Each bonus
     *      counts from the earlier of the instalment's due date and the moment
     *      it was paid, and the next must count from at least BONUS_PERIOD
     *      later. Measured on the block, the weekly Pay in 4 the product sells
     *      lost bonuses it had earned: its instalments fall due exactly a week
     *      apart, so a keeper that collected one a second sooner after its due
     *      date than the last, or a retry inside grace followed by a prompt
     *      collection, landed under a week and withheld an on-time bonus. A
     *      hostile keeper could do that to every other instalment on purpose.
     *      On the schedule, instalments a week apart are a week apart whatever
     *      the lag, and paying inside grace costs nothing.
     *
     *      Paying early does not move the count forward: an instalment paid
     *      before its due date counts from the moment it was paid. Otherwise a
     *      farmer, who chooses the due dates of its own plans, could open one
     *      due a week out, prepay it at once, and take a bonus the moment the
     *      previous one landed. The cost is that an early payment inside a week
     *      of the last bonus earns none; waiting for the due date never earns
     *      less. Nor does counting from the due date let collections run the
     *      ration ahead: an instalment scored on time was paid inside its grace
     *      period, so it counts from no earlier than the grace period before
     *      the block, and each bonus counts from a week after the last. Two
     *      bonuses can land up to one grace period under a week apart on the
     *      clock, but that is borrowed once, not per bonus: N of them still
     *      span N-1 weeks of schedule, and N bonuses after a report need N
     *      full weeks of clock.
     *
     *      Writers are trusted to pass the real due date; a writer can already
     *      pay a bonus outright with `recordOnTimePayment`.
     *
     *      `onTimePayments` counts every on-time instalment recorded here,
     *      rationed or not; the score moves at most once per BONUS_PERIOD.
     */
    function recordOnTimeInstallment(address user, uint256 dueAt)
        external
        onlyWriter
        returns (bool scored)
    {
        Profile storage p = _touch(user);
        p.onTimePayments += 1;

        uint256 countsFrom = dueAt < block.timestamp ? dueAt : block.timestamp;
        uint256 last = lastBonusAt[user];
        if (last != 0 && countsFrom < last + BONUS_PERIOD) return false;

        lastBonusAt[user] = uint64(countsFrom);
        _adjust(user, p, int256(uint256(ON_TIME_BONUS)), "on-time payment");
        return true;
    }

    /**
     * @notice Pay an on-time bonus outright, with no ration.
     * @dev Kept for the imported interface. Every Polaris engine records
     *      instalments through `recordOnTimeInstallment`; this still starts the
     *      bonus clock, so a bonus paid here is one the ration sees.
     */
    function recordOnTimePayment(address user) external onlyWriter {
        Profile storage p = _touch(user);
        p.onTimePayments += 1;
        lastBonusAt[user] = uint64(block.timestamp);
        _adjust(user, p, int256(uint256(ON_TIME_BONUS)), "on-time payment");
    }

    function recordLatePayment(address user) external onlyWriter {
        Profile storage p = _touch(user);
        p.latePayments += 1;
        _adjust(user, p, -int256(uint256(LATE_PENALTY)), "late payment");
    }

    /**
     * @notice Record a liquidation. The DECLINE_AT_LIQUIDATIONS-th closes the
     *         wallet's unsecured line for good.
     * @dev The penalty alone is not enough. Every score under 580 reads as the
     *      $200 floor tier, the minimum score included, so a wallet that had
     *      been underwritten once could borrow its $200, revoke the allowance,
     *      default, and do it again every few days for ever, each round booked
     *      in full as bad debt. Two liquidations elsewhere decline a report
     *      outright; two here now close the line the same way. The secured path
     *      stays open, at face value.
     */
    function recordLiquidation(address user) external onlyWriter {
        Profile storage p = _touch(user);
        p.liquidations += 1;
        _adjust(user, p, -int256(uint256(DEFAULT_PENALTY)), "liquidation");
        if (p.liquidations >= DECLINE_AT_LIQUIDATIONS && !p.declined) {
            p.declined = true;
            emit DeclinedForDefaults(user, p.liquidations);
        }
    }

    function _touch(address user) private returns (Profile storage p) {
        p = _profiles[user];
        if (!p.initialized) {
            p.initialized = true;
            p.score = STARTING_SCORE;
            p.firstSeenAt = uint64(block.timestamp);
        }
    }

    function _adjust(address user, Profile storage p, int256 delta, string memory reason) private {
        uint16 old = p.score;
        int256 next = int256(uint256(old)) + delta;
        if (next < int256(uint256(MIN_SCORE))) next = int256(uint256(MIN_SCORE));
        if (next > int256(uint256(MAX_SCORE))) next = int256(uint256(MAX_SCORE));
        p.score = uint16(uint256(next));
        emit ScoreChanged(user, old, p.score, reason);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}

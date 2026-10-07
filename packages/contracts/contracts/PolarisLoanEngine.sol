// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

import {ScoreManager} from "./ScoreManager.sol";

interface ICollateralSeize {
    function seize(address user, uint256 amount, address to) external returns (uint256);
}

interface IMerchantChecks {
    function canOriginate(address merchant, uint256 orderValue) external view returns (bool);
    function recordSettlement(address merchant, uint256 amount) external;
}

/**
 * @title PolarisLoanEngine
 * @notice Undercollateralized BNPL. A borrower splits a purchase into equal
 *         installments; the merchant is paid up front from protocol liquidity;
 *         the keeper collects each installment when it falls due.
 *
 * @dev The collection model is a pull, not a push. At checkout the borrower
 *      approves this contract for the full repayment amount once, and each
 *      installment is drawn with transferFrom. That is what lets a keeper
 *      collect on schedule without the borrower being online.
 *
 *      There are three ways money comes in, and they differ in who decides:
 *        collectInstallment(loanId)   anyone; takes no amount, draws exactly
 *                                     the instalment that has fallen due
 *        repay(loanId, amount)        the borrower only; any amount, any time
 *        repayWithSig(loanId, amount, expectedRepaid, deadline, sig)
 *                                     anyone, carrying the borrower's signed
 *                                     RepayIntent for that loan, amount and
 *                                     the loan's state when they signed
 *      The keeper path is permissionless because the schedule, not the caller,
 *      decides what moves and when, so a stranger can only ever do what the
 *      borrower already agreed to. `repay` takes an arbitrary amount, and that
 *      is why it is the borrower's alone: open to anyone, it let a stranger
 *      drain the whole standing allowance the moment a plan opened. See its
 *      note. `repayWithSig` is the same payment for a borrower who holds no
 *      gas, which on Monad is every borrower: the signature, not the sender,
 *      is the borrower's consent.
 *
 *      Paying on time raises the score, but slowly and only for real plans:
 *      none from a plan under MIN_SCORED_PRINCIPAL, and at most one bonus a
 *      week per borrower, rationed by ScoreManager on the instalments' due
 *      dates so every engine shares one clock. See `_applyPayment`.
 *
 *      Two functions exist purely for the keeper and are the reason this
 *      protocol maps cleanly onto KeeperHub's check-and-execute:
 *        checkLiquidatable(loanId) -> bool     (the condition, a pure view)
 *        liquidate(loanId)                     (the action)
 *      Evaluating both inside a single KeeperHub call closes the window in
 *      which a borrower repaying at the last second could still be liquidated
 *      on a stale read.
 */
contract PolarisLoanEngine is Ownable, ReentrancyGuard, EIP712, Nonces {
    using SafeERC20 for IERC20;

    /// Annualised interest, in basis points.
    uint256 public constant INTEREST_RATE_BPS = 1000; // 10%
    /// Share of interest kept by the protocol.
    uint256 public constant PROTOCOL_FEE_BPS = 2000; // 20%
    /// Default grace period when the deployer does not specify one.
    uint256 public constant DEFAULT_GRACE_PERIOD = 3 days;
    /// Upper bound, so a misconfigured deployment cannot make loans
    /// effectively un-liquidatable.
    uint256 public constant MAX_GRACE_PERIOD = 30 days;

    /**
     * @notice How long an installment may be overdue before the loan becomes
     *         liquidatable.
     * @dev Immutable per deployment rather than a global constant: a consumer
     *      book wants days, a machine-to-machine book wants minutes, and a
     *      testnet deployment wants seconds so the liquidation path can be
     *      demonstrated without waiting three days. Set once at construction
     *      so it can never be changed under a live loan.
     */
    uint256 public immutable gracePeriod;

    /// Shortest instalment interval a deployment may use when none is given.
    uint64 public constant DEFAULT_MIN_INTERVAL = 1 hours;
    /// Floor on any configured minimum, so no deployment can allow a schedule
    /// that is due in full at origination.
    uint64 public constant MIN_ALLOWED_INTERVAL = 60;

    /**
     * @notice Shortest instalment interval this deployment accepts.
     * @dev Immutable per deployment for the same reason as `gracePeriod`: a
     *      consumer book wants an hour or more, and a demo deployment wants a
     *      minute so a whole plan's life can be shown end to end.
     */
    uint64 public immutable minInterval;

    /**
     * @notice The smallest plan whose instalments can raise a score.
     * @dev A plan below this still opens, still collects and still costs a
     *      late payment or a liquidation; it just earns no bonus. Repaying a
     *      few cents says nothing about how a borrower handles credit, and with
     *      no floor the bonus was free: interest on a dust plan rounds to zero.
     */
    uint256 public constant MIN_SCORED_PRINCIPAL = 20e6;

    /// EIP-712 typehash for the borrower's signed payment. `expectedRepaid` is
    /// the loan's `totalRepaid` when the borrower signed. See `repayWithSig`.
    bytes32 public constant REPAY_INTENT_TYPEHASH = keccak256(
        "RepayIntent(uint256 loanId,uint256 amount,uint256 expectedRepaid,uint256 nonce,uint256 deadline)"
    );

    enum LoanStatus {
        Active,
        Repaid,
        Liquidated
    }

    struct Loan {
        address borrower;
        address merchant;
        uint128 principal;
        uint128 totalOwed;
        uint128 totalRepaid;
        uint32 installmentCount;
        uint32 installmentsPaid;
        uint64 startedAt;
        uint64 intervalSeconds;
        LoanStatus status;
    }

    IERC20 public immutable stablecoin;
    ScoreManager public immutable scoreManager;
    address public treasury;

    mapping(uint256 => Loan) public loans;
    mapping(address => uint256) public activeDebtOf;
    mapping(address => bool) public isOriginator;

    uint256 public loanCount;
    uint256 public protocolFeesAccrued;
    /// Unrecovered value from liquidations. The protocol's own loss ledger.
    /// Liquidation is the only write-off: whatever it cannot recover from the
    /// borrower's allowance or collateral lands here, and nothing lowers it.
    uint256 public badDebt;

    /**
     * @notice What every active loan still owes, in total: the sum of
     *         `outstandingOf(id)` over the loans whose status is Active, which
     *         is also the sum of `activeDebtOf` over every borrower.
     * @dev A running counter, moved in the same statements as `activeDebtOf`:
     *      up by a plan's `totalOwed` when it opens, down by what each payment
     *      delivers (`collectInstallment`, `repay`, `repayWithSig`), and down
     *      by the whole outstanding balance when a loan is liquidated, whatever
     *      that recovers (the shortfall moves to `badDebt`). Not to be confused
     *      with a Loan's own `totalOwed`, which is the plan's original total
     *      and never falls. The CRE guardian attests it (GuardianReceiver).
     */
    uint256 public totalOwed;

    /// @notice The sum of every plan's `totalOwed` at origination, ever: the
    ///         denominator of the lifetime loss rate the guardian checks
    ///         (`badDebt / totalOriginated`). It only ever grows.
    uint256 public totalOriginated;

    /// Every loan id a borrower has had, in the order they opened.
    mapping(address => uint256[]) private _loanIdsOf;

    /// Optional. When set, liquidation seizes collateral toward the shortfall.
    ICollateralSeize public collateralVault;
    /// Optional. When set, origination enforces merchant activation and caps.
    IMerchantChecks public merchantRegistry;

    /// What the CRE guardian reads from the pool in one call (`poolState`).
    struct PoolState {
        /// The pool's stablecoin balance less accrued protocol fees: what can
        /// pay merchants now, and what `withdrawLiquidity` may take.
        uint256 freeCash;
        uint256 totalOwed;
        uint256 badDebt;
        uint256 totalOriginated;
    }

    event LoanCreated(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed merchant,
        uint256 principal,
        uint256 totalOwed,
        uint32 installments
    );
    event InstallmentPaid(
        uint256 indexed loanId,
        address indexed borrower,
        uint32 installmentIndex,
        uint256 amount,
        bool onTime
    );
    /// Emitted alongside InstallmentPaid when the payment came through
    /// collectInstallment, so an indexer can tell a keeper's collection from a
    /// payment the borrower made themselves.
    event InstallmentCollected(uint256 indexed loanId, address indexed caller, uint256 amount);
    /// An instalment completed on time but earned no bonus: the plan is under
    /// MIN_SCORED_PRINCIPAL, or the borrower's weekly ration in ScoreManager
    /// was already spent. Emitted so the app can say why the score did not
    /// move.
    event OnTimeBonusWithheld(uint256 indexed loanId, address indexed borrower);
    /// A borrower cancelled their next signed RepayIntent without paying.
    event NonceInvalidated(address indexed borrower, uint256 nonce);
    event LoanFullyRepaid(uint256 indexed loanId, address indexed borrower);
    event LoanLiquidated(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 outstanding,
        uint256 recovered
    );
    event LiquidityWithdrawn(address indexed to, uint256 amount);
    event CollateralVaultSet(address indexed vault);
    event MerchantRegistrySet(address indexed registry);
    event OriginatorSet(address indexed originator, bool allowed);
    event TreasuryChanged(address indexed treasury);

    error NotOriginator();
    error InvalidLoan();
    error LoanNotActive();
    error ZeroAmount();
    error InvalidInstallments();
    error NotLiquidatable();
    error ExceedsCreditLimit();
    error InvalidGracePeriod();
    error InsufficientAllowance(uint256 have, uint256 need);
    error InsufficientBalance(uint256 have, uint256 need);
    error NotDue();
    error NotBorrower();
    error SignatureExpired();
    error InvalidSignature();
    error StaleIntent(uint256 repaid, uint256 expected);
    error InvalidInterval();
    error MerchantNotEligible();
    error ZeroAddress();
    error InsufficientLiquidity();

    modifier onlyOriginator() {
        if (!isOriginator[msg.sender]) revert NotOriginator();
        _;
    }

    constructor(
        address initialOwner,
        IERC20 _stablecoin,
        ScoreManager _scoreManager,
        address _treasury,
        uint256 _gracePeriod,
        uint64 _minInterval
    ) Ownable(initialOwner) EIP712("PolarisLoanEngine", "1") {
        if (_gracePeriod > MAX_GRACE_PERIOD) revert InvalidGracePeriod();
        gracePeriod = _gracePeriod == 0 ? DEFAULT_GRACE_PERIOD : _gracePeriod;
        if (_minInterval != 0 && (_minInterval < MIN_ALLOWED_INTERVAL || _minInterval > 30 days)) {
            revert InvalidInterval();
        }
        minInterval = _minInterval == 0 ? DEFAULT_MIN_INTERVAL : _minInterval;
        stablecoin = _stablecoin;
        scoreManager = _scoreManager;
        treasury = _treasury;
    }

    // -----------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------

    function setOriginator(address originator, bool allowed) external onlyOwner {
        isOriginator[originator] = allowed;
        emit OriginatorSet(originator, allowed);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasuryChanged(_treasury);
    }

    function setCollateralVault(ICollateralSeize vault) external onlyOwner {
        collateralVault = vault;
        emit CollateralVaultSet(address(vault));
    }

    function setMerchantRegistry(IMerchantChecks registry) external onlyOwner {
        merchantRegistry = registry;
        emit MerchantRegistrySet(address(registry));
    }

    /// @notice Seed protocol liquidity used to pay merchants up front.
    function fund(uint256 amount) external {
        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Withdraw idle liquidity.
     * @dev `fund` was previously one-way: there was no path out at all, so
     *      seeded capital was locked in the contract forever. Accrued fees are
     *      excluded from what is withdrawable, so a withdrawal cannot strand
     *      the treasury's claim.
     */
    function withdrawLiquidity(uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount > freeCash()) revert InsufficientLiquidity();
        stablecoin.safeTransfer(to, amount);
        emit LiquidityWithdrawn(to, amount);
    }

    // -----------------------------------------------------------------
    // Origination
    // -----------------------------------------------------------------

    /**
     * @notice Open a BNPL plan and pay the merchant immediately.
     * @dev The borrower must already have approved this contract for
     *      `totalOwed`; that single approval is what every later installment
     *      is drawn against.
     */
    function createLoan(
        address borrower,
        address merchant,
        uint256 principal,
        uint32 installmentCount,
        uint64 intervalSeconds
    ) external onlyOriginator nonReentrant returns (uint256 loanId) {
        if (principal == 0) revert ZeroAmount();
        if (installmentCount == 0 || installmentCount > 24) revert InvalidInstallments();
        // An unvalidated interval let a caller pass 0, which made the loan
        // interest-free and due in full at origination -- liquidatable one
        // grace period later, with a schedule that never existed.
        if (intervalSeconds < minInterval || intervalSeconds > 365 days) revert InvalidInterval();
        if (merchant == address(0) || borrower == address(0)) revert ZeroAddress();

        if (
            address(merchantRegistry) != address(0) &&
            !merchantRegistry.canOriginate(merchant, principal)
        ) {
            revert MerchantNotEligible();
        }

        uint256 term = uint256(installmentCount) * uint256(intervalSeconds);
        uint256 interest = (principal * INTEREST_RATE_BPS * term) / (10_000 * 365 days);
        uint256 owed = principal + interest;

        if (activeDebtOf[borrower] + owed > scoreManager.creditLimitOf(borrower)) {
            revert ExceedsCreditLimit();
        }

        // The whole collection model rests on a standing allowance. Paying the
        // merchant without one is a guaranteed total loss: every later repay
        // reverts and liquidation has nothing to pull.
        //
        // The comparison is against everything this borrower owes, not just the
        // loan being opened. A single allowance backs every open plan at once,
        // and nothing is drawn at origination -- so checking only `totalOwed`
        // let one approval sized for a single plan support as many loans as the
        // credit limit allowed. Settling the first legitimately exhausted the
        // allowance, `repay` on the rest then reverted, and `_recoverFromAllowance`
        // capped at an allowance of zero, so the full balance landed in badDebt
        // while the borrower still held the money. Exactly the total loss the
        // check above exists to prevent.
        uint256 required = activeDebtOf[borrower] + owed;
        uint256 allowed = stablecoin.allowance(borrower, address(this));
        if (allowed < required) revert InsufficientAllowance(allowed, required);

        loanId = ++loanCount;
        loans[loanId] = Loan({
            borrower: borrower,
            merchant: merchant,
            principal: uint128(principal),
            totalOwed: uint128(owed),
            totalRepaid: 0,
            installmentCount: installmentCount,
            installmentsPaid: 0,
            startedAt: uint64(block.timestamp),
            intervalSeconds: intervalSeconds,
            status: LoanStatus.Active
        });
        activeDebtOf[borrower] += owed;
        totalOwed += owed;
        totalOriginated += owed;
        _loanIdsOf[borrower].push(loanId);

        // Merchant is paid now, in full. That is the product.
        stablecoin.safeTransfer(merchant, principal);

        emit LoanCreated(loanId, borrower, merchant, principal, owed, installmentCount);
    }

    // -----------------------------------------------------------------
    // Collection -- what the keeper calls
    // -----------------------------------------------------------------

    /**
     * @notice Cumulative amount that must have been repaid for `k` installments
     *         to count as complete.
     * @dev Rounded up, and the schedule and the progress check both read from
     *      this one function. An earlier version computed the instalment amount
     *      by rounding down and inferred progress by rounding down again, so a
     *      full payment landed one unit short of its own threshold and counted
     *      as zero. One canonical ladder removes that class of bug entirely.
     */
    function thresholdFor(uint256 loanId, uint32 k) public view returns (uint256) {
        Loan storage l = loans[loanId];
        if (k == 0) return 0;
        if (k >= l.installmentCount) return uint256(l.totalOwed);
        uint256 num = uint256(l.totalOwed) * uint256(k);
        return (num + l.installmentCount - 1) / l.installmentCount;
    }

    /// @notice Amount due to complete the next unpaid installment.
    function installmentAmount(uint256 loanId) public view returns (uint256) {
        Loan storage l = loans[loanId];
        if (l.borrower == address(0)) revert InvalidLoan();
        if (l.installmentsPaid >= l.installmentCount) return 0;
        uint256 target = thresholdFor(loanId, l.installmentsPaid + 1);
        uint256 repaid = uint256(l.totalRepaid);
        return target > repaid ? target - repaid : 0;
    }

    /// @notice How many installments the money received actually covers.
    function installmentsEarned(uint256 loanId) public view returns (uint32) {
        Loan storage l = loans[loanId];
        uint32 k = 0;
        // Bounded by the 24-installment cap enforced at origination.
        while (k < l.installmentCount && uint256(l.totalRepaid) >= thresholdFor(loanId, k + 1)) {
            k++;
        }
        return k;
    }

    /// @notice When installment `index` (0-based) becomes collectable.
    function installmentDueAt(uint256 loanId, uint32 index) public view returns (uint256) {
        Loan storage l = loans[loanId];
        return uint256(l.startedAt) + (uint256(index) + 1) * uint256(l.intervalSeconds);
    }

    /// @notice True when the next installment is due now.
    function isInstallmentDue(uint256 loanId) public view returns (bool) {
        Loan storage l = loans[loanId];
        if (l.status != LoanStatus.Active) return false;
        return block.timestamp >= installmentDueAt(loanId, l.installmentsPaid);
    }

    /**
     * @notice Collect the instalment that has fallen due. This is what the
     *         keeper calls.
     * @dev Permissionless, and takes no amount. It draws exactly
     *      `installmentAmount(loanId)`, what completes the next unpaid
     *      instalment, and only once that instalment is due. The schedule the
     *      borrower agreed to decides what moves and when, so a stranger calling
     *      this can only ever do what the borrower already consented to. They
     *      can never pull the rest of the standing allowance early.
     *
     *      A shortfall is reported before any transfer is attempted, as an error
     *      a keeper can branch on without decoding a token's revert string. The
     *      two map onto different rungs of the dunning ladder: a lost allowance
     *      is something the borrower has to sign again, a short balance is
     *      something they have to top up, and telling them the wrong one duns a
     *      buyer for our mistake. Allowance is checked first because without it
     *      the balance is irrelevant: the engine cannot touch it however large
     *      it is.
     *
     * @return collected What the token actually delivered.
     */
    function collectInstallment(uint256 loanId)
        external
        nonReentrant
        returns (uint256 collected)
    {
        Loan storage l = loans[loanId];
        if (l.borrower == address(0)) revert InvalidLoan();
        if (l.status != LoanStatus.Active || l.installmentsPaid >= l.installmentCount) {
            revert LoanNotActive();
        }
        if (block.timestamp < installmentDueAt(loanId, l.installmentsPaid)) revert NotDue();

        uint256 amount = installmentAmount(loanId);
        address borrower = l.borrower;

        uint256 allowed = stablecoin.allowance(borrower, address(this));
        if (allowed < amount) revert InsufficientAllowance(allowed, amount);
        uint256 held = stablecoin.balanceOf(borrower);
        if (held < amount) revert InsufficientBalance(held, amount);

        collected = _applyPayment(loanId, l, amount);
        emit InstallmentCollected(loanId, msg.sender, collected);
    }

    /**
     * @notice Pay `amount` toward the loan: part of an instalment, several
     *         instalments, or the whole balance early.
     * @dev The borrower's alone. This used to be callable by anyone, on the
     *      reasoning that funds can only move from the borrower to this
     *      contract, so the worst a hostile caller could do was pay somebody's
     *      debt early. That early payment was the harm. With an arbitrary
     *      amount, a stranger could drain a borrower's whole standing allowance
     *      the moment a plan opened, taking money the borrower meant to spend
     *      on other things weeks before any of it was due. The Solana build
     *      fixed the same hole by making its permissionless path take no
     *      amount; here that path is `collectInstallment`.
     *
     *      An amount above what is outstanding is capped rather than refused, so
     *      paying off everything never needs the exact figure.
     */
    function repay(uint256 loanId, uint256 amount) external nonReentrant {
        Loan storage l = loans[loanId];
        if (l.borrower == address(0)) revert InvalidLoan();
        if (msg.sender != l.borrower) revert NotBorrower();
        _repay(loanId, l, amount);
    }

    /**
     * @notice `repay`, for a borrower who holds no gas: anyone may submit the
     *         borrower's signed RepayIntent.
     * @dev Making `repay` the borrower's alone closed the allowance drain, but
     *      on Monad the borrower is a Mera account that never holds MON, so on
     *      its own it also closed the only way such a borrower could prepay, or
     *      cure a missed instalment inside the grace period before anyone
     *      could liquidate. The signature restores both without reopening the
     *      drain: it names the loan and the amount, so whoever relays it can
     *      move exactly what the borrower chose, into this loan, and nothing
     *      else. The nonce stops a relayer replaying it, and the deadline
     *      stops one holding it back for later.
     *
     *      It also names the loan's `totalRepaid` at signing, and is refused
     *      once any other payment has landed on the loan. A borrower who
     *      signs a cure for an overdue instalment chose to pay that
     *      instalment, not to prepay the next. Without the binding, the
     *      keeper's retry could collect the instalment first, and the cure
     *      then landed as a prepayment, drawing a second instalment a week or
     *      more early; and an intent the borrower had covered by paying
     *      directly could still be spent, drawing the same amount twice. Any
     *      payment to the loan, by anyone, now retires the intents signed
     *      before it. `invalidateNonce` cancels one without paying.
     */
    function repayWithSig(
        uint256 loanId,
        uint256 amount,
        uint256 expectedRepaid,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        Loan storage l = loans[loanId];
        if (l.borrower == address(0)) revert InvalidLoan();
        if (block.timestamp > deadline) revert SignatureExpired();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    REPAY_INTENT_TYPEHASH,
                    loanId,
                    amount,
                    expectedRepaid,
                    _useNonce(l.borrower),
                    deadline
                )
            )
        );
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != l.borrower) revert InvalidSignature();
        // After the signature, so a forged or replayed intent reads as one
        // whatever the loan's state, and a stale one is told apart from both.
        if (uint256(l.totalRepaid) != expectedRepaid) {
            revert StaleIntent(l.totalRepaid, expectedRepaid);
        }

        _repay(loanId, l, amount);
    }

    /**
     * @notice Cancel the caller's next signed RepayIntent without paying.
     * @dev For a borrower who holds gas and changes their mind about an intent
     *      a relayer still holds. A borrower who does not can let the deadline
     *      run out, or pay the loan, which retires it.
     */
    function invalidateNonce() external returns (uint256 nonce) {
        nonce = _useNonce(msg.sender);
        emit NonceInvalidated(msg.sender, nonce);
    }

    /// What `repay` and `repayWithSig` share once the borrower's consent is
    /// established.
    function _repay(uint256 loanId, Loan storage l, uint256 amount) private {
        if (l.status != LoanStatus.Active) revert LoanNotActive();
        if (amount == 0) revert ZeroAmount();
        if (l.installmentsPaid >= l.installmentCount) revert LoanNotActive();

        uint256 remaining = uint256(l.totalOwed) - uint256(l.totalRepaid);
        if (amount > remaining) amount = remaining;

        _applyPayment(loanId, l, amount);
    }

    /**
     * @notice Draw `requested` from the borrower and book what arrives against
     *         the loan.
     * @dev The one place a payment is accounted for. `repay`, `repayWithSig`
     *      and `collectInstallment` differ only in who may call them and how
     *      the amount is chosen; sharing this means a keeper's collection and a
     *      borrower's own payment can never be credited, scored, charged a fee
     *      or closed differently.
     * @return amount What the token actually delivered.
     */
    function _applyPayment(uint256 loanId, Loan storage l, uint256 requested)
        private
        returns (uint256 amount)
    {
        // Measure what the token actually delivered rather than trusting the
        // requested amount. A fee-on-transfer stablecoin -- USDC supports the
        // mechanism and merely has it disabled -- would otherwise over-credit
        // the borrower for money the contract never received.
        uint256 balanceBefore = stablecoin.balanceOf(address(this));
        stablecoin.safeTransferFrom(l.borrower, address(this), requested);
        amount = stablecoin.balanceOf(address(this)) - balanceBefore;
        if (amount == 0) revert ZeroAmount();

        bool onTime = block.timestamp <=
            installmentDueAt(loanId, l.installmentsPaid) + gracePeriod;

        l.totalRepaid += uint128(amount);
        activeDebtOf[l.borrower] -= amount;
        totalOwed -= amount;

        /*
         * Derive instalments-paid from money actually received, never by
         * incrementing per call.
         *
         * Incrementing was exploitable: a borrower could call repay() with one
         * base unit, four times, and the loan would show 4/4 collected while
         * ~200 was still owed -- and, because checkLiquidatable() returns false
         * once installmentsPaid reaches installmentCount, the loan would be
         * permanently un-liquidatable. Dust bought immunity.
         *
         * The proportion is exact for an equal schedule and monotonic in
         * totalRepaid, so a partial payment moves the borrower toward the next
         * instalment without ever completing one it did not cover.
         */
        // 0-based index of the instalment this payment goes toward, captured
        // before the counter moves. Using `installmentsPaid - 1` after the fact
        // underflows when a partial payment completes nothing.
        uint32 targetIndex = l.installmentsPaid;

        // Progress is read off the same canonical ladder the schedule is built
        // from, so a payment that meets its threshold always counts and one
        // that does not never does.
        uint32 earned = installmentsEarned(loanId);
        bool completedOne = earned > l.installmentsPaid;
        l.installmentsPaid = earned;

        /*
         * Accrue the protocol's share of *actual* interest, proportionally.
         *
         * The previous formula treated 10% of every repayment as interest and
         * took 20% of that -- roughly 2% of the whole loan. Real interest is
         * annualised and pro-rated over the term, so on any plan shorter than
         * about 75 days the fee exceeded every penny of interest earned and the
         * difference came out of merchant-payout liquidity. A 200 loan over 40
         * days repaid perfectly on time still lost the pool money.
         */
        uint256 totalInterest = uint256(l.totalOwed) - uint256(l.principal);
        if (totalInterest > 0) {
            uint256 feeOnThisPayment =
                (amount * totalInterest * PROTOCOL_FEE_BPS) / (uint256(l.totalOwed) * 10_000);
            if (feeOnThisPayment > 0) {
                protocolFeesAccrued += feeOnThisPayment;
            }
        }

        // Index is 0-based to match installmentDueAt, so an indexer can join
        // the event to the schedule without an off-by-one.
        emit InstallmentPaid(loanId, l.borrower, targetIndex, amount, onTime);

        // Score only moves when an instalment actually completed. A partial
        // payment is progress, not a payment event, and scoring it would let a
        // borrower farm their score with dust.
        //
        // A late instalment always costs, whatever the plan's size: trust is
        // fast to lose. An on-time one earns only on a plan of at least
        // MIN_SCORED_PRINCIPAL, and only as often as ScoreManager's weekly
        // ration allows, counted on the instalment's due date, so neither
        // dust, nor prepaying a plan one unit at a time, nor twenty plans at
        // once, nor a second engine can buy a tier, while a weekly plan
        // collected with any lag inside grace earns every week. A dust plan
        // writes nothing to the score record; either way the event says why.
        if (completedOne) {
            address borrower = l.borrower;
            if (!onTime) {
                scoreManager.recordLatePayment(borrower);
            } else if (
                l.principal < MIN_SCORED_PRINCIPAL ||
                !scoreManager.recordOnTimeInstallment(
                    borrower,
                    installmentDueAt(loanId, targetIndex)
                )
            ) {
                emit OnTimeBonusWithheld(loanId, borrower);
            }
        }

        if (l.totalRepaid >= l.totalOwed) {
            l.status = LoanStatus.Repaid;
            emit LoanFullyRepaid(loanId, l.borrower);
        }
    }

    // -----------------------------------------------------------------
    // Liquidation -- the check-and-execute pair
    // -----------------------------------------------------------------

    /**
     * @notice The condition half of the keeper's check-and-execute.
     * @dev A pure view returning a plain bool, so KeeperHub can evaluate it as
     *      a condition and branch on it without interpreting protocol types.
     */
    function checkLiquidatable(uint256 loanId) public view returns (bool) {
        Loan storage l = loans[loanId];
        if (l.borrower == address(0)) return false;
        if (l.status != LoanStatus.Active) return false;
        if (l.installmentsPaid >= l.installmentCount) return false;
        return block.timestamp > installmentDueAt(loanId, l.installmentsPaid) + gracePeriod;
    }

    /**
     * @notice The action half. Reverts unless the condition genuinely holds.
     *
     * @dev This used to move zero tokens. It marked the loan liquidated, freed
     *      `activeDebtOf`, dinged the score and stopped -- which made it
     *      *profitable* for the defaulter, who could call it on themselves to
     *      have the debt written off and their credit line released, then
     *      borrow again against the 200-unit score floor. That loop was
     *      infinite and cost the pool the full principal every round.
     *
     *      Now it recovers what it can, in order:
     *        1. whatever the borrower's standing allowance still permits
     *        2. seized collateral, if a vault is configured
     *      and books the unrecovered remainder as bad debt so the protocol has
     *      an on-chain measure of its own losses.
     */
    function liquidate(uint256 loanId) external nonReentrant {
        if (!checkLiquidatable(loanId)) revert NotLiquidatable();

        Loan storage l = loans[loanId];
        uint256 outstanding = uint256(l.totalOwed) - uint256(l.totalRepaid);

        l.status = LoanStatus.Liquidated;
        activeDebtOf[l.borrower] -= outstanding;
        totalOwed -= outstanding;

        uint256 recovered = _recoverFromAllowance(l.borrower, outstanding);

        if (address(collateralVault) != address(0) && recovered < outstanding) {
            recovered += collateralVault.seize(
                l.borrower,
                outstanding - recovered,
                address(this)
            );
        }

        l.totalRepaid += uint128(recovered);
        if (recovered < outstanding) {
            badDebt += outstanding - recovered;
        }

        scoreManager.recordLiquidation(l.borrower);
        emit LoanLiquidated(loanId, l.borrower, outstanding, recovered);
    }

    /// Pull whatever the borrower's remaining allowance and balance permit.
    function _recoverFromAllowance(address borrower, uint256 want)
        private
        returns (uint256)
    {
        uint256 allowed = stablecoin.allowance(borrower, address(this));
        uint256 held = stablecoin.balanceOf(borrower);
        uint256 take = want;
        if (take > allowed) take = allowed;
        if (take > held) take = held;
        if (take == 0) return 0;

        uint256 before = stablecoin.balanceOf(address(this));
        stablecoin.safeTransferFrom(borrower, address(this), take);
        return stablecoin.balanceOf(address(this)) - before;
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------

    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return loans[loanId];
    }

    function outstandingOf(uint256 loanId) external view returns (uint256) {
        Loan storage l = loans[loanId];
        return uint256(l.totalOwed) - uint256(l.totalRepaid);
    }

    /// @notice Every loan id `borrower` has had, oldest first, whatever its
    ///         status. The collections workflow's instant retry reads it (via
    ///         `CollectionsReceiver.dueTasksFor`) when a borrower re-signs.
    function loanIdsOf(address borrower) external view returns (uint256[] memory) {
        return _loanIdsOf[borrower];
    }

    /// @notice The pool's stablecoin balance less accrued protocol fees: what
    ///         can pay merchants now.
    function freeCash() public view returns (uint256) {
        uint256 balance = stablecoin.balanceOf(address(this));
        return balance > protocolFeesAccrued ? balance - protocolFeesAccrued : 0;
    }

    /// @notice The pool figures the CRE guardian attests, in one read.
    function poolState() external view returns (PoolState memory) {
        return PoolState({
            freeCash: freeCash(),
            totalOwed: totalOwed,
            badDebt: badDebt,
            totalOriginated: totalOriginated
        });
    }

    function sweepFees() external onlyOwner {
        if (treasury == address(0)) revert ZeroAddress();
        uint256 amount = protocolFeesAccrued;
        protocolFeesAccrued = 0;
        if (amount > 0) {
            stablecoin.safeTransfer(treasury, amount);
        }
    }
}

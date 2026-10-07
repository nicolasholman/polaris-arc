// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IERC3009} from "./interfaces/IERC3009.sol";

/**
 * @title PolarisPayments
 * @notice The two payment modes that are not credit: pay now, and subscribe.
 *
 * @dev Both use the same mechanism as BNPL collection -- the payer grants one
 *      ERC-20 allowance and the protocol draws against it -- because that is
 *      what lets a keeper charge on schedule without the payer being online.
 *      Recurring payments in crypto normally fail on exactly this point: the
 *      only alternative is an unlimited allowance the merchant can drain at
 *      will, which is why almost nobody ships subscriptions on chain.
 *
 *      What makes the allowance safe here is that this contract, not the
 *      merchant, is the spender, and it will only ever move `pricePerPeriod`
 *      and only once per `periodSeconds`. A subscriber can cancel at any time,
 *      and cancelling is unilateral -- it needs no merchant cooperation.
 *
 *      `chargeDue` is permissionless for the same reason `repay` is on the
 *      LoanEngine: funds can only travel subscriber -> merchant on a schedule
 *      the subscriber already agreed to, so a third-party keeper calling it is
 *      harmless and keeps collection decentralised.
 *
 *      On Polaris no buyer or merchant is expected to hold gas, so every
 *      action here also has a form a relayer can submit:
 *        payWithAuthorization  pay an order from an ERC-3009 authorization
 *        quoteOrder            an operator pins an order's price for a merchant
 *        subscribeFor          the checkout subscribes a buyer who signed
 *        createPlanFor         an operator publishes a merchant's plan
 *        cancelWithSignature   a subscriber cancels by EIP-712 signature
 *      Wherever money moves, a signature from the account it belongs to
 *      decides where it goes -- checked here, or for `subscribeFor` by the
 *      checkout contract the owner appointed to check it. The relayer
 *      carries the transaction; it can't redirect it.
 */
contract PolarisPayments is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// Protocol fee on every payment, in basis points. 50 = 0.5%.
    uint256 public feeBps = 50;
    uint256 public constant MAX_FEE_BPS = 500;

    IERC20 public immutable stablecoin;
    address public treasury;

    /// Shortest subscription period a deployment may use when none is given.
    uint64 public constant DEFAULT_MIN_PERIOD = 1 hours;
    /// Floor on any configured minimum.
    uint64 public constant MIN_ALLOWED_PERIOD = 60;

    /**
     * @notice Shortest subscription period this deployment accepts.
     * @dev Immutable per deployment, mirroring the loan engine's
     *      `minInterval`: production wants an hour or more, a demo wants a
     *      minute so a renewal can be shown on camera.
     */
    uint64 public immutable minPeriod;

    /// What a subscriber signs to cancel without sending a transaction.
    bytes32 public constant CANCEL_SUBSCRIPTION_TYPEHASH =
        keccak256("CancelSubscription(uint256 subId,uint256 deadline)");

    /**
     * @notice The one contract allowed to subscribe a buyer on their behalf.
     * @dev PolarisCheckout verifies the buyer's signed intent and permit
     *      before it calls `subscribeFor`. This contract trusts it to have
     *      done so, which is why only the owner can appoint it, and why it
     *      must be a contract (see `setCheckout`).
     */
    address public checkout;

    /**
     * @notice Accounts that may publish plans and quote orders for merchants.
     * @dev A merchant onboarded through Polaris for Business holds no MON, so
     *      the relayer publishes plans and pins order prices in its name.
     *
     *      The role is global, and the operator chooses which merchant it
     *      acts for, so it can publish a plan in any merchant's name. What
     *      bounds it: a plan only ever pays the merchant it names, so an
     *      operator can't route money to itself; it can retire only plans
     *      published through `createPlanFor`, never one a merchant published
     *      itself, so a merchant that holds gas and never delegated keeps
     *      sole control of its own plans; and it can't move anyone's money or
     *      touch a live subscription.
     */
    mapping(address => bool) public isOperator;

    /**
     * @notice Plans published on a merchant's behalf through `createPlanFor`.
     * @dev These are the only plans an operator may retire. Without the
     *      distinction any operator could permanently close every plan in
     *      the protocol, including those merchants published and paid gas
     *      for themselves, and there is no way to reopen a plan.
     */
    mapping(uint256 => bool) public publishedOnBehalf;

    // -----------------------------------------------------------------
    // Direct payments
    // -----------------------------------------------------------------

    struct Payment {
        address payer;
        address merchant;
        uint128 amount;
        uint64 paidAt;
    }

    mapping(bytes32 => Payment) public payments;
    uint256 public paymentCount;

    /**
     * @notice The price pinned on an order before it was paid, by merchant
     *         and payment id. Zero means the order was never quoted.
     * @dev An order id is only a string, so without a quote nothing on chain
     *      ties an order to a price and whoever pays an id first owns it at
     *      any amount: 1 micro-AUSD marks a 200 AUSD order paid and kills the
     *      buyer's signed payment with `DuplicatePayment`. A quoted order can
     *      only be paid at exactly its price, by either path. Keyed by
     *      merchant as well as id, so a quote only ever governs orders that
     *      pay the merchant it names, and one merchant can't pin a price on
     *      another's order.
     */
    mapping(address => mapping(bytes32 => uint256)) public quotedAmount;

    /**
     * @notice Orders the checkout settled as Pay in 4 or Subscribe, by
     *         payment id. Such an order can never be paid here as well.
     * @dev An order settles once, in one mode. The checkout refuses to open
     *      a plan or a subscription on an order already paid here, and this
     *      is the other half: without it, a Pay now authorization the buyer
     *      signed for the same order (a relay that timed out, say, before the
     *      buyer chose Pay in 4 instead) stays redeemable by anyone through
     *      `payWithAuthorization`, and charges the buyer in full on top of
     *      the plan.
     *
     *      Kept here rather than read from the checkout's own book, so it
     *      binds whichever checkout is appointed later, and still binds with
     *      none: replacing or switching off the checkout cannot reopen an
     *      order it settled.
     */
    mapping(bytes32 => bool) public settledByCheckout;

    event PaymentMade(
        bytes32 indexed paymentId,
        address indexed payer,
        address indexed merchant,
        uint256 amount,
        uint256 fee,
        string orderId
    );
    event OrderQuoted(bytes32 indexed paymentId, address indexed merchant, uint256 amount);

    // -----------------------------------------------------------------
    // Subscriptions
    // -----------------------------------------------------------------

    enum SubStatus {
        Active,
        Cancelled,
        Lapsed
    }

    struct Plan {
        address merchant;
        uint128 pricePerPeriod;
        uint64 periodSeconds;
        bool active;
        string name;
    }

    struct Subscription {
        address subscriber;
        uint256 planId;
        uint64 startedAt;
        uint64 nextChargeAt;
        uint32 periodsCharged;
        uint32 missedCharges;
        SubStatus status;
    }

    mapping(uint256 => Plan) public plans;
    mapping(uint256 => Subscription) public subscriptions;
    /// One live subscription per (subscriber, plan), so a double-subscribe is
    /// impossible rather than merely discouraged.
    mapping(address => mapping(uint256 => uint256)) public subscriptionOf;

    uint256 public planCount;
    uint256 public subscriptionCount;

    /// How long after the due time a charge may still be collected. Past this
    /// the period is skipped rather than stacked, so a subscriber returning
    /// after a month is not hit with four charges at once.
    uint64 public constant CHARGE_WINDOW = 7 days;
    /// Consecutive misses before a subscription lapses.
    uint32 public constant MAX_MISSES = 3;

    event PlanCreated(uint256 indexed planId, address indexed merchant, uint256 price, uint64 period);
    event PlanDeactivated(uint256 indexed planId);
    event Subscribed(uint256 indexed subId, uint256 indexed planId, address indexed subscriber);
    event SubscriptionCharged(uint256 indexed subId, uint256 amount, uint256 fee, uint32 period);
    event SubscriptionCancelled(uint256 indexed subId, address indexed by);
    event SubscriptionLapsed(uint256 indexed subId, uint32 misses);
    event ChargeMissed(uint256 indexed subId, uint32 misses, string reason);
    event FeeChanged(uint256 bps);
    event CheckoutSet(address indexed checkout);
    event OperatorSet(address indexed operator, bool allowed);

    error ZeroAmount();
    error ZeroAddress();
    error PlanNotActive();
    error AlreadySubscribed();
    error NotSubscriber();
    error SubscriptionNotActive();
    error NotDue();
    error InvalidPeriod();
    error InvalidFee();
    error DuplicatePayment();
    error UnexpectedAmount(uint256 expected, uint256 received);
    error NotCheckout();
    error NotOperator();
    error SignatureExpired();
    error WrongAmount(uint256 quoted, uint256 offered);
    error CheckoutNotAContract(address checkout);
    error InvalidMerchant(address merchant);
    error OrderAlreadySettled(bytes32 paymentId);

    constructor(address initialOwner, IERC20 _stablecoin, address _treasury, uint64 _minPeriod)
        Ownable(initialOwner)
        EIP712("PolarisPayments", "1")
    {
        if (_minPeriod != 0 && (_minPeriod < MIN_ALLOWED_PERIOD || _minPeriod > 30 days)) {
            revert InvalidPeriod();
        }
        stablecoin = _stablecoin;
        treasury = _treasury;
        minPeriod = _minPeriod == 0 ? DEFAULT_MIN_PERIOD : _minPeriod;
    }

    function setFeeBps(uint256 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert InvalidFee();
        feeBps = bps;
        emit FeeChanged(bps);
    }

    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
    }

    /**
     * @notice Appoint the checkout. The zero address switches relayed
     *         subscriptions, and Pay in 4 through the checkout, off: the
     *         checkout records every plan's order here (see
     *         `markSettledByCheckout`) and can't while it isn't appointed.
     * @dev Refuses an address with no code. A buyer's subscription permit is
     *      one pooled allowance to this contract, sized for a year of the
     *      plan they chose, and nothing here ties it to that plan: whoever is
     *      checkout can spend it on any plan, including one an attacker
     *      published a moment ago priced at the whole allowance. That is safe
     *      only while the checkout is a contract that holds every call to the
     *      buyer's signed `SubscribeIntent`. An EOA -- the relayer's server
     *      wallet, say -- would put every outstanding permit behind one hot
     *      key.
     */
    function setCheckout(address _checkout) external onlyOwner {
        if (_checkout != address(0) && _checkout.code.length == 0) {
            revert CheckoutNotAContract(_checkout);
        }
        checkout = _checkout;
        emit CheckoutSet(_checkout);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    // -----------------------------------------------------------------
    // Direct payment
    // -----------------------------------------------------------------

    /**
     * @notice Pay a merchant in full, now.
     * @dev `orderId` is hashed with the merchant to form the payment id, so a
     *      merchant cannot be paid twice for the same order by a retrying
     *      checkout -- the second call reverts rather than charging again.
     *      If the order was quoted, only its quoted price pays it.
     */
    function pay(address merchant, uint256 amount, string calldata orderId)
        external
        nonReentrant
        returns (bytes32 paymentId)
    {
        paymentId = _recordPayment(msg.sender, merchant, amount, orderId);
        _settle(merchant, msg.sender, amount);
        emit PaymentMade(paymentId, msg.sender, merchant, amount, _fee(amount), orderId);
    }

    /**
     * @notice Pay a merchant from the buyer's signed ERC-3009 authorization,
     *         so a buyer who holds AUSD but no gas pays with a signature and
     *         nothing else. Anyone may submit it; in practice the relayer does.
     *
     * @dev The ERC-3009 nonce is not a parameter. This contract derives it as
     *      the payment id, `keccak256(merchant, orderId)`, exactly as `pay`
     *      does, and hands that to the token. The buyer's signature covers the
     *      nonce, so it commits to this merchant and this order: a relayer
     *      that swaps the merchant changes the nonce and the token rejects the
     *      signature, so it can't redirect the money; one that swaps the order
     *      id is rejected the same way, so one authorization can't pay a
     *      different order.
     *
     *      It calls `receiveWithAuthorization`, not `transferWithAuthorization`,
     *      because the receive variant only runs when the payee is the caller.
     *      An authorization naming this contract can't be lifted from the
     *      mempool and submitted to the token directly, which would move the
     *      money without recording the payment.
     *
     *      The id is shared with `pay`, so an order can't be paid once each
     *      way: whichever lands first records it and the other reverts with
     *      `DuplicatePayment`. A replayed authorization fails the same way,
     *      and would fail again at the token as a spent nonce. An order the
     *      checkout already settled as Pay in 4 or Subscribe refuses both
     *      with `OrderAlreadySettled`, so a buyer who signed Pay now and then
     *      chose a plan instead can't be charged twice by the unused
     *      authorization.
     *
     *      First come, first served cuts both ways. This call exposes the
     *      merchant and order id while it is pending, so anyone -- the relayer
     *      included -- can pay the same order first with `pay` and kill the
     *      buyer's authorization. On an unquoted order that costs them 1
     *      micro-AUSD and leaves the order recorded as paid at that amount.
     *      Quote the order with `quoteOrder` when the session is created and
     *      the race can only be won by paying the full price to the
     *      merchant; either way, match `payer` and `amount` before fulfilling
     *      (see `paymentFor`).
     *
     *      The money lands here and is split by `safeTransfer` with the same
     *      `_fee` that `pay` applies. The balance delta is measured rather than
     *      trusted, so a token that reports success without delivering the
     *      full amount can't mark an order paid.
     */
    function payWithAuthorization(
        address payer,
        address merchant,
        uint256 amount,
        string calldata orderId,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bytes32 paymentId) {
        if (payer == address(0) || merchant == address(0)) revert ZeroAddress();

        paymentId = _recordPayment(payer, merchant, amount, orderId);
        _receiveAuthorized(payer, amount, validAfter, validBefore, paymentId, v, r, s);
        uint256 fee = _payOut(merchant, amount);

        emit PaymentMade(paymentId, payer, merchant, amount, fee, orderId);
    }

    /**
     * @notice Pin an order's price before anyone can pay it, so that only
     *         that price can. The merchant can do this, and so can the owner
     *         or an operator acting for a merchant that holds no gas; the
     *         checkout-session service does it when it creates a session.
     * @dev Takes the payment id, not the order id, so the quote reveals
     *      nothing `pay` needs: a watcher who sees it can't pay the order
     *      without the order id, and by the time the buyer's payment reveals
     *      the id, the price is already pinned. Anyone racing that payment
     *      can then only pay the full price to the merchant, which settles
     *      the order instead of griefing it.
     *
     *      Order ids should still be unpredictable. A guessable id can be
     *      claimed before its quote lands; the quote then reverts with
     *      `DuplicatePayment` and the session has to pick a new id.
     *
     *      A quote can be replaced until the order is settled, and never
     *      after, so the price an order was paid at can't be rewritten.
     */
    function quoteOrder(address merchant, bytes32 paymentId, uint256 amount) external {
        if (msg.sender != merchant && msg.sender != owner() && !isOperator[msg.sender]) {
            revert NotOperator();
        }
        if (merchant == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (payments[paymentId].paidAt != 0) revert DuplicatePayment();
        if (settledByCheckout[paymentId]) revert OrderAlreadySettled(paymentId);

        quotedAmount[merchant][paymentId] = amount;
        emit OrderQuoted(paymentId, merchant, amount);
    }

    /**
     * @notice Record that the checkout settled this order as Pay in 4 or
     *         Subscribe, so that no payment here can settle it again.
     *         Checkout only.
     * @dev PolarisCheckout calls this for every plan and subscription it
     *      opens, before any money moves, and refuses the order itself if it
     *      was already paid here. Refused here too for an order already paid
     *      or marked, so the two records can never both hold for one order.
     *      Only the appointed checkout can call it: anyone else could mark an
     *      order nobody has paid and make it unpayable.
     */
    function markSettledByCheckout(bytes32 paymentId) external {
        if (msg.sender != checkout) revert NotCheckout();
        if (payments[paymentId].paidAt != 0 || settledByCheckout[paymentId]) {
            revert OrderAlreadySettled(paymentId);
        }
        settledByCheckout[paymentId] = true;
    }

    /**
     * @notice The payment recorded for an order, if any.
     * @dev A record proves only that `payer` paid `amount` for this id. It
     *      does not prove the order was paid in full, or by the buyer the
     *      merchant expected: an unquoted order id belongs to whoever pays it
     *      first, at any amount. Before fulfilling, the merchant, the checkout
     *      and the indexer behind `payment.succeeded` must match `amount`,
     *      and `payer` where it matters, against the order -- or quote the
     *      order with `quoteOrder`, so that nothing but its price can pay it.
     *
     *      An order settled as Pay in 4 or Subscribe has no payment record;
     *      `settledByCheckout` says so, and the checkout's `orderOf` has the
     *      details.
     */
    function paymentFor(address merchant, string calldata orderId)
        external
        view
        returns (Payment memory)
    {
        return payments[keccak256(abi.encodePacked(merchant, orderId))];
    }

    // -----------------------------------------------------------------
    // Plans
    // -----------------------------------------------------------------

    function createPlan(uint256 pricePerPeriod, uint64 periodSeconds, string calldata name)
        external
        returns (uint256 planId)
    {
        return _createPlan(msg.sender, pricePerPeriod, periodSeconds, name);
    }

    /**
     * @notice Publish a plan that pays `merchant`, for a merchant who holds no
     *         gas. Owner or operator only.
     * @dev Safe to delegate because a plan moves nothing on its own: money
     *      only flows once a subscriber signs up, and then only to the merchant
     *      named here. The caller chooses that merchant, so this can publish a
     *      plan in any merchant's name; the merchant can retire it with
     *      `deactivatePlan`. The validation is `createPlan`'s, `minPeriod`
     *      included.
     *
     *      Two payees are refused. This contract can't spend what a plan pays
     *      it, so every subscriber's money would be locked here for good. The
     *      treasury is not a merchant; a plan paying it would let the
     *      protocol's own operator bill subscribers to itself.
     */
    function createPlanFor(
        address merchant,
        uint256 pricePerPeriod,
        uint64 periodSeconds,
        string calldata name
    ) external returns (uint256 planId) {
        if (msg.sender != owner() && !isOperator[msg.sender]) revert NotOperator();
        if (merchant == address(0)) revert ZeroAddress();
        if (merchant == address(this) || merchant == treasury) revert InvalidMerchant(merchant);

        planId = _createPlan(merchant, pricePerPeriod, periodSeconds, name);
        publishedOnBehalf[planId] = true;
    }

    /**
     * @notice Stop new sign-ups to a plan. The plan's merchant can do this,
     *         and so can an operator for a plan published on a merchant's
     *         behalf through `createPlanFor`.
     * @dev Live subscriptions keep charging: deactivating a plan closes it to
     *      newcomers, it does not cancel anyone. A plan the merchant published
     *      itself stays the merchant's alone, because retiring is permanent
     *      and that merchant never delegated anything.
     */
    function deactivatePlan(uint256 planId) external {
        Plan storage p = plans[planId];
        // Nobody may retire an id that does not exist yet, or an indexer
        // would see a plan retired before it was created.
        if (p.merchant == address(0)) revert PlanNotActive();
        bool asOperator = publishedOnBehalf[planId] && isOperator[msg.sender];
        if (msg.sender != p.merchant && !asOperator) revert NotSubscriber();
        p.active = false;
        emit PlanDeactivated(planId);
    }

    // -----------------------------------------------------------------
    // Subscriptions
    // -----------------------------------------------------------------

    /**
     * @notice Subscribe and pay the first period immediately.
     * @dev Charging period one at subscribe time means a subscription always
     *      starts from a proven-good payment, so a plan can never sit "active"
     *      having never collected anything.
     */
    function subscribe(uint256 planId) external nonReentrant returns (uint256 subId) {
        return _subscribe(msg.sender, planId);
    }

    /**
     * @notice Subscribe `subscriber` on their behalf. Checkout only.
     * @dev `subscribe` takes the subscriber from `msg.sender`, so it can't be
     *      relayed. This is the relayed form: the checkout has already checked
     *      the buyer's signed intent and submitted their permit, and the first
     *      period is drawn from the subscriber's own allowance to this
     *      contract, never from the checkout. Everything else is `subscribe`.
     *
     *      The allowance is not tied to a plan, so this contract can't tell
     *      whether `planId` is the one the buyer chose. The checkout must: it
     *      has to pass the plan id the buyer signed and refuse a plan priced
     *      above what they signed for. That is why the checkout must be a
     *      contract (see `setCheckout`).
     */
    function subscribeFor(address subscriber, uint256 planId)
        external
        nonReentrant
        returns (uint256 subId)
    {
        if (msg.sender != checkout) revert NotCheckout();
        if (subscriber == address(0)) revert ZeroAddress();
        return _subscribe(subscriber, planId);
    }

    /// @notice True when this subscription is collectable right now.
    /// @dev An id never subscribed reads as an Active slot due at time zero,
    ///      so the zero subscriber is checked first. Without it this said
    ///      "due" for every unused id, and a keeper or CRE workflow trusting it
    ///      sent charges that could only fail.
    function isChargeDue(uint256 subId) public view returns (bool) {
        Subscription storage s = subscriptions[subId];
        if (s.subscriber == address(0) || s.status != SubStatus.Active) return false;
        return block.timestamp >= s.nextChargeAt;
    }

    /**
     * @notice Collect one period. Permissionless -- this is the keeper entry
     *         point, and it is the subscription analogue of `LoanEngine.repay`.
     */
    function chargeDue(uint256 subId) external nonReentrant {
        Subscription storage s = subscriptions[subId];
        // An unwritten slot reads as Active; refused here rather than panicking
        // on its plan's zero period below.
        if (s.subscriber == address(0) || s.status != SubStatus.Active) revert SubscriptionNotActive();
        if (block.timestamp < s.nextChargeAt) revert NotDue();

        Plan storage p = plans[s.planId];

        // Past the window the period is skipped, not stacked. Advancing to the
        // next boundary rather than adding one period stops a long-absent
        // subscriber from owing a backlog of charges they never consumed.
        if (block.timestamp > s.nextChargeAt + CHARGE_WINDOW) {
            s.missedCharges += 1;
            uint64 periods = (uint64(block.timestamp) - s.nextChargeAt) / p.periodSeconds + 1;
            s.nextChargeAt += periods * p.periodSeconds;
            emit ChargeMissed(subId, s.missedCharges, "charge window elapsed");

            if (s.missedCharges >= MAX_MISSES) {
                s.status = SubStatus.Lapsed;
                emit SubscriptionLapsed(subId, s.missedCharges);
            }
            return;
        }

        _settle(p.merchant, s.subscriber, p.pricePerPeriod);

        s.periodsCharged += 1;
        s.missedCharges = 0;
        s.nextChargeAt += p.periodSeconds;

        emit SubscriptionCharged(subId, p.pricePerPeriod, _fee(p.pricePerPeriod), s.periodsCharged);
    }

    /**
     * @notice Cancel. The subscriber can always do this unilaterally; the
     *         merchant can also cancel, which is how a merchant offboards.
     */
    function cancel(uint256 subId) external {
        Subscription storage s = subscriptions[subId];
        if (s.status != SubStatus.Active) revert SubscriptionNotActive();
        if (msg.sender != s.subscriber && msg.sender != plans[s.planId].merchant) {
            revert NotSubscriber();
        }
        s.status = SubStatus.Cancelled;
        emit SubscriptionCancelled(subId, msg.sender);
    }

    /**
     * @notice Cancel from the subscriber's EIP-712 signature, so a subscriber
     *         who holds no gas can still leave unilaterally. Anyone may submit.
     * @dev The subscriber signs `CancelSubscription(subId, deadline)` under
     *      this contract's domain. Binding `subId` means a signature can never
     *      cancel another subscription, and the domain binds this deployment
     *      and chain. No nonce is needed: cancelling is terminal and a
     *      subscription id is never reused, so a replay finds the
     *      subscription already cancelled. The deadline limits how long a
     *      signature the subscriber chose not to send stays usable.
     */
    function cancelWithSignature(uint256 subId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (block.timestamp > deadline) revert SignatureExpired();

        Subscription storage sub = subscriptions[subId];
        // A slot that was never written reads as Active with a zero
        // subscriber, and a garbage signature recovers to the zero address.
        // Refusing an unwritten slot outright means a future id can never be
        // "cancelled" before it exists, whatever recovery does with bad input.
        if (sub.subscriber == address(0) || sub.status != SubStatus.Active) {
            revert SubscriptionNotActive();
        }

        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(CANCEL_SUBSCRIPTION_TYPEHASH, subId, deadline)));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
        if (err != ECDSA.RecoverError.NoError || signer != sub.subscriber) revert NotSubscriber();

        sub.status = SubStatus.Cancelled;
        emit SubscriptionCancelled(subId, sub.subscriber);
    }

    function getSubscription(uint256 subId) external view returns (Subscription memory) {
        return subscriptions[subId];
    }

    function getPlan(uint256 planId) external view returns (Plan memory) {
        return plans[planId];
    }

    // -----------------------------------------------------------------

    function _fee(uint256 amount) private view returns (uint256) {
        return (amount * feeBps) / 10_000;
    }

    /// Move funds payer -> merchant, net of fee, in one place so direct
    /// payments and subscriptions cannot drift apart on fee handling.
    function _settle(address merchant, address payer, uint256 amount) private {
        uint256 fee = _fee(amount);
        stablecoin.safeTransferFrom(payer, merchant, amount - fee);
        if (fee > 0) {
            stablecoin.safeTransferFrom(payer, treasury, fee);
        }
    }

    /// Claim an order's id and record who paid it, before any token moves.
    /// Both payment paths go through here, which is what makes an order
    /// payable exactly once whichever path lands first, never payable once
    /// the checkout settled it as a plan or a subscription, and a quoted
    /// order payable only at its price whichever path is used.
    function _recordPayment(address payer, address merchant, uint256 amount, string calldata orderId)
        private
        returns (bytes32 paymentId)
    {
        if (amount == 0) revert ZeroAmount();

        paymentId = keccak256(abi.encodePacked(merchant, orderId));
        if (payments[paymentId].paidAt != 0) revert DuplicatePayment();
        if (settledByCheckout[paymentId]) revert OrderAlreadySettled(paymentId);

        uint256 quoted = quotedAmount[merchant][paymentId];
        if (quoted != 0 && amount != quoted) revert WrongAmount(quoted, amount);

        payments[paymentId] = Payment({
            payer: payer,
            merchant: merchant,
            // Checked, not truncated, so the record can't disagree with the
            // amount that moved and was emitted.
            amount: SafeCast.toUint128(amount),
            paidAt: uint64(block.timestamp)
        });
        paymentCount++;
    }

    /// Pull `amount` from `payer` under their ERC-3009 authorization, with
    /// this contract as the payee, and confirm all of it arrived.
    function _receiveAuthorized(
        address payer,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        uint256 balanceBefore = stablecoin.balanceOf(address(this));
        IERC3009(address(stablecoin)).receiveWithAuthorization(
            payer, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );
        uint256 received = stablecoin.balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert UnexpectedAmount(amount, received);
    }

    /// Split funds this contract already holds: net to the merchant, fee to
    /// the treasury. The same `_fee` as `_settle`, so a signed payment and a
    /// direct one cost the merchant exactly the same.
    function _payOut(address merchant, uint256 amount) private returns (uint256 fee) {
        fee = _fee(amount);
        stablecoin.safeTransfer(merchant, amount - fee);
        if (fee > 0) {
            stablecoin.safeTransfer(treasury, fee);
        }
    }

    function _subscribe(address subscriber, uint256 planId) private returns (uint256 subId) {
        Plan storage p = plans[planId];
        if (!p.active) revert PlanNotActive();

        uint256 existing = subscriptionOf[subscriber][planId];
        if (existing != 0 && subscriptions[existing].status == SubStatus.Active) {
            revert AlreadySubscribed();
        }

        subId = ++subscriptionCount;
        subscriptions[subId] = Subscription({
            subscriber: subscriber,
            planId: planId,
            startedAt: uint64(block.timestamp),
            nextChargeAt: uint64(block.timestamp) + p.periodSeconds,
            periodsCharged: 1,
            missedCharges: 0,
            status: SubStatus.Active
        });
        subscriptionOf[subscriber][planId] = subId;

        _settle(p.merchant, subscriber, p.pricePerPeriod);
        emit Subscribed(subId, planId, subscriber);
        emit SubscriptionCharged(subId, p.pricePerPeriod, _fee(p.pricePerPeriod), 1);
    }

    function _createPlan(
        address merchant,
        uint256 pricePerPeriod,
        uint64 periodSeconds,
        string calldata name
    ) private returns (uint256 planId) {
        if (pricePerPeriod == 0) revert ZeroAmount();
        // Checked, not truncated: 2^128 would pass the zero check and be
        // stored as a free plan anyone could join with no balance, and
        // 2^128 + 20 AUSD would charge 20 AUSD while PlanCreated announced
        // the untruncated price.
        uint128 price = SafeCast.toUint128(pricePerPeriod);
        // A period under the deployment's minimum is almost certainly a
        // mistake, and one over a year makes the allowance a standing risk for
        // no benefit.
        if (periodSeconds < minPeriod || periodSeconds > 365 days) revert InvalidPeriod();

        planId = ++planCount;
        plans[planId] = Plan({
            merchant: merchant,
            pricePerPeriod: price,
            periodSeconds: periodSeconds,
            active: true,
            name: name
        });
        emit PlanCreated(planId, merchant, pricePerPeriod, periodSeconds);
    }
}

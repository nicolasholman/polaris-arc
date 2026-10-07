// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IERC3009} from "./interfaces/IERC3009.sol";

/**
 * @title PolarisSplit
 * @notice Split the bill by link. One person (the organiser) paid, or wants
 *         to share a cost; they open a split of named or equal shares and
 *         share one link. Each friend pays their share with one signature,
 *         the money lands with the organiser in the same transaction, and the
 *         chain keeps who paid which share. Nobody holds gas.
 *
 * @dev Three entry points, none of which reads `msg.sender`, so a relayer
 *      submits all of them. Each carries the signature of the account it acts
 *      for:
 *        createSplit  the organiser signs `CreateSplit`: the shares' amounts,
 *                     a salt the split's id is derived from, the hash of the
 *                     link's text, and the expiry.
 *        payShare     the friend signs an ERC-3009 `ReceiveWithAuthorization`
 *                     for exactly the share's amount, payable to this
 *                     contract, with a nonce this contract derives from the
 *                     split and the share.
 *        closeSplit   the organiser signs `CloseSplit`: unpaid shares can no
 *                     longer be paid.
 *
 *      No custody. A share's dollars arrive and leave in the same call: the
 *      friend's authorization pulls them here, and they go straight on to the
 *      organiser. There is no balance between transactions, no owner, no
 *      admin, no fee and nothing to withdraw, so there is nothing here for
 *      anyone to take. Closing a split therefore refunds nothing: what was
 *      paid is already the organiser's, and what was not paid never moved.
 *
 *      Why a contract of its own, rather than one PolarisPayments order per
 *      share through `payWithAuthorization`:
 *        - A split must be closable. Once the organiser closes it, a friend's
 *          authorization that is still in flight must not land. Anyone can
 *          submit an ERC-3009 authorization, so a flag in the API can't stop
 *          it; only the contract that spends it can refuse.
 *        - A share's price is the organiser's. `payWithAuthorization` takes
 *          whatever amount the payer signs on an unquoted order, and quoting
 *          is an operator's or the merchant's call, not a friend's.
 *        - Friends settling up pay no fee. PolarisPayments takes the
 *          merchant fee on every payment.
 *        - "3 of 5 paid", and who paid which share, are read from the chain,
 *          not from the API's memory.
 *
 *      Why `receiveWithAuthorization` into this contract, and not a
 *      `transferWithAuthorization` straight to the organiser: the receive
 *      variant only runs when its payee is the caller. An authorization
 *      naming this contract can only be spent through `payShare`, which
 *      records the share as it goes. A transfer authorization naming the
 *      organiser could be lifted from the mempool and submitted to the token
 *      directly: the organiser would be paid, the share would stay unpaid,
 *      and the friend would be asked to pay it again.
 *
 *      Why the nonce commits to the split and the share: the friend's
 *      signature then pays this share of this split and nothing else. A
 *      relayer that points it at another split, or at another share of the
 *      same split, changes the nonce, and the token rejects it. The amount is
 *      read from the split, never taken from the caller, so a share can only
 *      ever be paid in full, once.
 *
 *      A split's id is keccak256(abi.encode(organiser, salt)). The organiser
 *      signs the salt, so nobody who sees a pending `createSplit` can open a
 *      split under that id first (with other amounts) and take over the link
 *      the organiser is about to share. The app knows the id before the split
 *      lands, so it can build the link at once.
 *
 *      The split's words (what it is for, the organiser's name, and a label
 *      for each share, "Sam" or "Share 2") are not on chain: they travel in
 *      the link, like a send link's sender name, so a public chain never ties
 *      a friend's name to their account. The split stores `memoHash`, the
 *      hash of those words the organiser signed, so the app can tell whether
 *      the text in a link is the organiser's.
 *
 *      Every signature is short-lived: a create's or a close's `deadline`, and
 *      a share's `validBefore`, must fall within MAX_SIGNATURE_WINDOW of the
 *      block it lands in, as on PolarisSend and PolarisCheckout. A signature a
 *      relayer withholds dies within the hour. A create or a close can't be
 *      replayed: a split id is opened once, and a split closes once.
 */
contract PolarisSplit is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// Most shares one split may have. Keeps a split's storage and every
    /// loop over it small; a dinner for fifty is still one split.
    uint256 public constant MAX_SHARES = 50;
    /// Longest a split may stay payable.
    uint64 public constant MAX_EXPIRY = 60 days;
    /// Shortest a split may live: less could expire before a friend's
    /// payment reaches the chain.
    uint64 public constant MIN_LIFETIME = 5 minutes;
    /// Longest any signature may still have to run when it lands.
    uint64 public constant MAX_SIGNATURE_WINDOW = 1 hours;

    bytes32 public constant CREATE_TYPEHASH = keccak256(
        "CreateSplit(address organiser,bytes32 salt,uint128[] amounts,bytes32 memoHash,uint64 expiresAt,uint256 deadline)"
    );
    bytes32 public constant CLOSE_TYPEHASH = keccak256("CloseSplit(bytes32 splitId,uint256 deadline)");

    /// What the organiser signs to open a split.
    struct Creation {
        address organiser;
        bytes32 salt;
        /// One amount per share, in the stablecoin's base units.
        uint128[] amounts;
        /// keccak256 of the link's text (see the header); zero if none.
        bytes32 memoHash;
        uint64 expiresAt;
        uint256 deadline;
    }

    /// A split's state. Two slots, plus the memo hash.
    struct Split {
        address organiser;
        uint64 expiresAt;
        uint8 shareCount;
        uint8 paidCount;
        bool closed;
        uint128 total;
        uint128 paidTotal;
        bytes32 memoHash;
    }

    IERC20 public immutable stablecoin;

    mapping(bytes32 => Split) private _splits;
    /// Each share's amount, by split.
    mapping(bytes32 => uint128[]) private _amounts;
    /// Who paid each share, by split and share index; zero while unpaid.
    mapping(bytes32 => mapping(uint256 => address)) public paidBy;

    event SplitCreated(
        bytes32 indexed splitId,
        address indexed organiser,
        uint256 total,
        uint128[] amounts,
        uint64 expiresAt,
        bytes32 memoHash
    );
    event SharePaid(
        bytes32 indexed splitId,
        uint256 indexed index,
        address indexed payer,
        uint256 amount,
        uint256 paidCount,
        uint256 shareCount
    );
    event SplitClosed(bytes32 indexed splitId, address indexed organiser, uint256 paidCount, uint256 shareCount);

    error ZeroAddress();
    error NoShares();
    error TooManyShares(uint256 count);
    error InvalidAmount(uint256 index);
    error InvalidExpiry();
    error SplitExists(bytes32 splitId);
    error SplitNotFound(bytes32 splitId);
    error SplitIsClosed(bytes32 splitId);
    error SplitExpired(bytes32 splitId);
    error ShareOutOfRange(uint256 index, uint256 shareCount);
    error ShareAlreadyPaid(uint256 index);
    error InvalidSignature();
    error SignatureExpired();
    error SignatureWindowTooLong();
    error UnexpectedAmount(uint256 expected, uint256 received);

    constructor(IERC20 _stablecoin) EIP712("PolarisSplit", "1") {
        if (address(_stablecoin) == address(0)) revert ZeroAddress();
        stablecoin = _stablecoin;
    }

    // -----------------------------------------------------------------
    // Create
    // -----------------------------------------------------------------

    /**
     * @notice Open a split. The organiser signs `CreateSplit`; anyone submits.
     * @dev Each share must be more than zero, the total must fit a uint128,
     *      and the expiry must fall between MIN_LIFETIME and MAX_EXPIRY from
     *      now. The id is the organiser's and the salt's, so the same
     *      signature can open a split once: a second submission finds it
     *      already open.
     */
    function createSplit(Creation calldata c, bytes calldata signature)
        external
        nonReentrant
        returns (bytes32 splitId)
    {
        if (c.organiser == address(0)) revert ZeroAddress();
        uint256 count = c.amounts.length;
        if (count == 0) revert NoShares();
        if (count > MAX_SHARES) revert TooManyShares(count);
        if (c.expiresAt < block.timestamp + MIN_LIFETIME || c.expiresAt > block.timestamp + MAX_EXPIRY) {
            revert InvalidExpiry();
        }
        _checkDeadline(c.deadline);

        uint256 total;
        for (uint256 i; i < count; ++i) {
            if (c.amounts[i] == 0) revert InvalidAmount(i);
            total += c.amounts[i];
        }
        // Each share fits a uint128 and there are at most 50, so this is the
        // only way the sum can outgrow its slot.
        if (total > type(uint128).max) revert InvalidAmount(count);

        splitId = splitIdOf(c.organiser, c.salt);
        if (_splits[splitId].organiser != address(0)) revert SplitExists(splitId);
        _requireSigned(c.organiser, _createStructHash(c), signature);

        _splits[splitId] = Split({
            organiser: c.organiser,
            expiresAt: c.expiresAt,
            // count <= MAX_SHARES (50), so it fits a uint8.
            shareCount: uint8(count),
            paidCount: 0,
            closed: false,
            total: uint128(total),
            paidTotal: 0,
            memoHash: c.memoHash
        });
        _amounts[splitId] = c.amounts;

        emit SplitCreated(splitId, c.organiser, total, c.amounts, c.expiresAt, c.memoHash);
    }

    // -----------------------------------------------------------------
    // Pay a share
    // -----------------------------------------------------------------

    /**
     * @notice Pay share `index` of a split from `payer`'s ERC-3009
     *         authorization, straight on to the organiser. Anyone submits.
     * @dev The authorization must be a `ReceiveWithAuthorization` from
     *      `payer`, payable to this contract, for exactly the share's amount,
     *      with the nonce `shareNonce(splitId, index)`. The token checks all
     *      of that: a signature for another amount, another share, another
     *      split or another signer is refused there.
     *
     *      The share is marked paid (and SharePaid emitted) before the token
     *      is asked, so the call is checks, effects, then interactions.
     *      Whatever arrives is measured, so a token that delivers less than
     *      asked cannot mark a share paid.
     */
    function payShare(
        bytes32 splitId,
        uint256 index,
        address payer,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        (address organiser, uint128 amount) = _claimShare(splitId, index, payer, validBefore);
        _receive(payer, amount, validAfter, validBefore, shareNonce(splitId, index), v, r, s);
        stablecoin.safeTransfer(organiser, amount);
    }

    // -----------------------------------------------------------------
    // Close
    // -----------------------------------------------------------------

    /**
     * @notice Stop a split: its unpaid shares can no longer be paid. The
     *         organiser signs `CloseSplit`; anyone submits.
     * @dev Nothing moves: paid shares are already the organiser's, and unpaid
     *      ones never left their payers. A split closes once, so the
     *      signature can't be used twice. An expired split can be closed too,
     *      so the organiser's list can say "closed" rather than "expired".
     */
    function closeSplit(bytes32 splitId, uint256 deadline, bytes calldata signature) external nonReentrant {
        Split storage split = _splits[splitId];
        address organiser = split.organiser;
        if (organiser == address(0)) revert SplitNotFound(splitId);
        if (split.closed) revert SplitIsClosed(splitId);
        _checkDeadline(deadline);
        _requireSigned(organiser, keccak256(abi.encode(CLOSE_TYPEHASH, splitId, deadline)), signature);

        split.closed = true;
        emit SplitClosed(splitId, organiser, split.paidCount, split.shareCount);
    }

    // -----------------------------------------------------------------
    // Views for clients
    // -----------------------------------------------------------------

    /// @notice A split's state; `organiser` is zero if there is none.
    function splitOf(bytes32 splitId) external view returns (Split memory) {
        return _splits[splitId];
    }

    /// @notice Each share's amount and who paid it (zero while unpaid).
    function sharesOf(bytes32 splitId) external view returns (uint128[] memory amounts, address[] memory payers) {
        amounts = _amounts[splitId];
        payers = new address[](amounts.length);
        for (uint256 i; i < amounts.length; ++i) {
            payers[i] = paidBy[splitId][i];
        }
    }

    /// @notice The id a split opened by `organiser` with `salt` has.
    function splitIdOf(address organiser, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(organiser, salt));
    }

    /**
     * @notice The ERC-3009 nonce a friend signs to pay share `index`.
     * @dev Exposed so the app derives the nonce from the code that checks it.
     */
    function shareNonce(bytes32 splitId, uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encode(splitId, index));
    }

    /// @notice The digest the organiser signs to open a split.
    function createDigest(Creation calldata c) external view returns (bytes32) {
        return _hashTypedDataV4(_createStructHash(c));
    }

    /// @notice The digest the organiser signs to close a split.
    function closeDigest(bytes32 splitId, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLOSE_TYPEHASH, splitId, deadline)));
    }

    // -----------------------------------------------------------------

    /// Every check `payShare` makes, then its effects: the share is recorded
    /// as paid (and SharePaid emitted) before the token is asked for anything.
    /// A revert further on undoes both. Split out of `payShare` only because
    /// its eight arguments leave no stack room to inline it.
    function _claimShare(bytes32 splitId, uint256 index, address payer, uint256 validBefore)
        private
        returns (address organiser, uint128 amount)
    {
        if (payer == address(0)) revert ZeroAddress();
        Split storage split = _splits[splitId];
        organiser = split.organiser;
        if (organiser == address(0)) revert SplitNotFound(splitId);
        if (split.closed) revert SplitIsClosed(splitId);
        if (block.timestamp >= split.expiresAt) revert SplitExpired(splitId);
        if (index >= split.shareCount) revert ShareOutOfRange(index, split.shareCount);
        if (paidBy[splitId][index] != address(0)) revert ShareAlreadyPaid(index);
        if (validBefore > block.timestamp + MAX_SIGNATURE_WINDOW) revert SignatureWindowTooLong();

        amount = _amounts[splitId][index];
        paidBy[splitId][index] = payer;
        uint8 paidCount = split.paidCount + 1;
        split.paidCount = paidCount;
        split.paidTotal += amount;
        emit SharePaid(splitId, index, payer, amount, paidCount, split.shareCount);
    }

    /// Pull `amount` from `payer` under their ERC-3009 authorization, payable
    /// to this contract, and check all of it arrived: measured, not assumed.
    function _receive(
        address payer,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        uint256 before = stablecoin.balanceOf(address(this));
        IERC3009(address(stablecoin)).receiveWithAuthorization(payer, address(this), amount, validAfter, validBefore, nonce, v, r, s);
        uint256 received = stablecoin.balanceOf(address(this)) - before;
        if (received != amount) revert UnexpectedAmount(amount, received);
    }

    /// EIP-712 encodes an array as the hash of its elements, each padded to a
    /// word, which is what `abi.encodePacked` does to an array's elements.
    function _createStructHash(Creation calldata c) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CREATE_TYPEHASH,
                c.organiser,
                c.salt,
                keccak256(abi.encodePacked(c.amounts)),
                c.memoHash,
                c.expiresAt,
                c.deadline
            )
        );
    }

    /// Refuse a signature past its deadline, or one that would stay usable
    /// for more than MAX_SIGNATURE_WINDOW from now.
    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (deadline > block.timestamp + MAX_SIGNATURE_WINDOW) revert SignatureWindowTooLong();
    }

    /// The organiser's own key first, then ERC-1271 for an account with
    /// code, in the order PolarisCheckout uses, so an EOA that has since
    /// delegated its code (EIP-7702) still signs with its key.
    function _requireSigned(address signer, bytes32 structHash, bytes calldata signature) private view {
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return;
        if (signer.code.length != 0 && SignatureChecker.isValidERC1271SignatureNowCalldata(signer, digest, signature)) {
            return;
        }
        revert InvalidSignature();
    }
}

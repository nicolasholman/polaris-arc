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
 * @title PolarisSend
 * @notice Send dollars across borders as a link. The sender signs once, a
 *         relayer escrows the money here, and whoever opens the link claims it
 *         to any address. Neither side ever holds gas.
 *
 * @dev The link is a URL whose fragment (`#k=...`) carries a throwaway private
 *      key. Browsers never send the fragment to a server, so the key travels
 *      only from the sender to the recipient. The key's address, the "link
 *      key", is what the escrow is filed under, and holding the key is what
 *      entitles someone to the money.
 *
 *      No entry point reads `msg.sender`, so a relayer can submit every one of
 *      them. What keeps the relayer honest is that each signature commits to
 *      where the money goes:
 *        send    the sender's ERC-3009 authorization commits to the link key
 *                and the expiry, through a nonce this contract derives, and
 *                the link key signs the sender, amount and expiry it opens.
 *        claim   the link key signs the recipient's address.
 *        cancel  the sender signs the link key being cancelled.
 *        refund  needs no signature, because it can only ever pay the sender.
 *
 *      A link key funds exactly one link, ever. That one rule is what makes
 *      every claim and cancel signature single-use without a nonce of its own:
 *      once a link is gone, nothing can be filed under its key again, so an old
 *      signature has nothing left to act on.
 *
 *      Only the holder of a link key can open a link under it. The relayer, an
 *      RPC node or anyone watching the mempool learns a key's address before
 *      the send lands. If that were enough, they could file a one-unit link of
 *      their own under it and cancel it at once: the key would be burned at no
 *      cost, the sender's authorization could never land, and the key's first
 *      `Sent` event would name a stranger. Because the key must sign, `Sent`
 *      under a link key always describes the link its holder opened.
 *
 *      Every signature here is short-lived. Its cutoff (a send's
 *      `validBefore`, a claim's or a cancel's `deadline`) must fall within
 *      MAX_SIGNATURE_WINDOW of the block it lands in, so a signature a relayer
 *      withholds dies within the hour. It cannot surface days later to open a
 *      week-long link with minutes left, cancel a link just ahead of the
 *      recipient's claim, or pay a claim to an address its holder has since
 *      corrected.
 */
contract PolarisSend is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// Longest a link may stay open. Past this, unclaimed money sits in escrow
    /// for no one's benefit, and a forgotten link stays a live bearer claim.
    uint64 public constant MAX_EXPIRY = 30 days;
    /// Shortest a link may live. Anything shorter could expire while the
    /// recipient's claim is still on its way to the chain.
    uint64 public constant MIN_LIFETIME = 5 minutes;
    /// Longest any signature may still have to run when it lands. An app that
    /// signs a longer-lived one is refused on its first try, so it cannot ship
    /// one by mistake and leave a relayer free to pick, days later, when it
    /// lands. Apps sign a few minutes; the hour is headroom for slow relaying
    /// and clock drift.
    uint64 public constant MAX_SIGNATURE_WINDOW = 1 hours;

    bytes32 public constant OPEN_TYPEHASH = keccak256("Open(address sender,uint256 amount,uint64 expiresAt)");
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address to,uint256 deadline)");
    bytes32 public constant CANCEL_TYPEHASH = keccak256("Cancel(address linkKey,uint256 deadline)");

    struct Link {
        address sender;
        uint128 amount;
        uint64 expiresAt;
    }

    IERC20 public immutable stablecoin;

    /// Open links by link key. A link that is claimed, cancelled or refunded
    /// is deleted, so a zero `sender` means there is nothing to pay out.
    mapping(address => Link) public links;
    /// Every link key that has ever funded a link. Never cleared.
    mapping(address => bool) public keyUsed;

    event Sent(address indexed linkKey, address indexed sender, uint256 amount, uint64 expiresAt);
    event Claimed(address indexed linkKey, address indexed to, uint256 amount);
    event Cancelled(address indexed linkKey, address indexed sender, uint256 amount);
    event Refunded(address indexed linkKey, address indexed sender, uint256 amount);

    error ZeroAddress();
    error LinkKeyUsed();
    error InvalidAmount();
    error InvalidExpiry();
    error UnexpectedAmount(uint256 expected, uint256 received);
    error LinkNotFound();
    error LinkExpired();
    error NotExpired();
    error InvalidOpenSignature();
    error InvalidClaimSignature();
    error SignatureExpired();
    error SignatureWindowTooLong();
    error NotSender();

    constructor(IERC20 _stablecoin) EIP712("PolarisSend", "1") {
        if (address(_stablecoin) == address(0)) revert ZeroAddress();
        stablecoin = _stablecoin;
    }

    // -----------------------------------------------------------------
    // Send
    // -----------------------------------------------------------------

    /**
     * @notice Escrow `amount` from `sender` against `linkKey` until
     *         `expiresAt`. Anyone may submit it; the sender's ERC-3009
     *         `ReceiveWithAuthorization` is what pays for it, and the link
     *         key's `Open` signature (`keyV`, `keyR`, `keyS`) is what files it
     *         under that key.
     * @dev The ERC-3009 nonce is not taken from the caller. This contract
     *      derives it as keccak256(abi.encode(linkKey, expiresAt)), so the
     *      sender's signature commits to this link key and this expiry. A
     *      relayer that swaps in a key it controls, to claim the money itself,
     *      changes the nonce, and the token rejects the signature. The token
     *      also requires its caller to be the payee, so the authorization
     *      cannot be spent anywhere but here.
     *
     *      The link key signs `Open(address sender,uint256 amount,uint64
     *      expiresAt)`. The app holds the key when it sends, so this costs the
     *      user nothing, and it stops anyone who has only seen the key's
     *      address from filing a link under it. Binding the sender means a
     *      watcher cannot lift the key's signature off a pending send and put
     *      it on an authorization of its own.
     *
     *      `validAfter` and `validBefore` pass through to the token. They bound
     *      when the authorization may be used, not how long the link lives;
     *      that is `expiresAt`. `validBefore` may be at most
     *      MAX_SIGNATURE_WINDOW past the block the send lands in.
     *
     *      If a send does not land, the app retries under the same link key.
     *      Whatever window or expiry the retry signs, the key can fund only
     *      one link, so a withheld first attempt that surfaces later cannot
     *      escrow the sender twice. A retry under a fresh key has no such
     *      guard. Before switching keys the app lets the first
     *      authorization's `validBefore` pass, or spends its nonce with the
     *      token's `cancelAuthorization(sender, sendNonce(linkKey, expiresAt))`.
     */
    function send(
        address sender,
        address linkKey,
        uint256 amount,
        uint64 expiresAt,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint8 keyV,
        bytes32 keyR,
        bytes32 keyS
    ) external nonReentrant {
        _checkSend(sender, linkKey, amount, expiresAt, validBefore, keyV, keyR, keyS);

        keyUsed[linkKey] = true;
        links[linkKey] = Link({sender: sender, amount: uint128(amount), expiresAt: expiresAt});

        _pull(sender, linkKey, amount, expiresAt, validAfter, validBefore, v, r, s);

        emit Sent(linkKey, sender, amount, expiresAt);
    }

    // -----------------------------------------------------------------
    // Claim
    // -----------------------------------------------------------------

    /**
     * @notice Pay the link out to `to`. Anyone may submit it; the link key's
     *         signature is what authorizes it.
     * @dev The link key signs `Claim(address to,uint256 deadline)`, so the
     *      recipient is part of what was signed. Someone watching the mempool
     *      can copy the signature but not change where the money goes: with
     *      any other `to` it recovers to a different address and is refused.
     *      The link key itself is not in the message because the signer is
     *      the link key.
     *
     *      Until its deadline passes, a signed claim cannot be taken back: if
     *      it lands, it pays the address it names. The app therefore signs
     *      only a destination the recipient has confirmed, and signs a claim
     *      to a different address only once the earlier claim's deadline has
     *      passed. The deadline may be at most MAX_SIGNATURE_WINDOW away,
     *      which is what keeps that wait short.
     */
    function claim(address linkKey, address to, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        Link memory link = links[linkKey];
        if (link.sender == address(0)) revert LinkNotFound();
        if (block.timestamp >= link.expiresAt) revert LinkExpired();
        if (to == address(0)) revert ZeroAddress();
        _requireLive(deadline);
        // `linkKey` is never zero for an open link, so a signature that fails
        // to recover (and yields the zero address) can never match it.
        if (_recover(claimDigest(to, deadline), v, r, s) != linkKey) revert InvalidClaimSignature();

        delete links[linkKey];
        stablecoin.safeTransfer(to, link.amount);

        emit Claimed(linkKey, to, link.amount);
    }

    // -----------------------------------------------------------------
    // Cancel and refund
    // -----------------------------------------------------------------

    /**
     * @notice Take back an unclaimed link. The sender signs; anyone submits.
     * @dev The sender signs `Cancel(address linkKey,uint256 deadline)`, so a
     *      cancel for one link cannot be replayed against another, and the
     *      money can only go back to the sender recorded at send time. The
     *      deadline may be at most MAX_SIGNATURE_WINDOW away, so a cancel the
     *      sender signed and then abandoned cannot be fired days later, just
     *      ahead of the recipient's claim. A cancel is accepted after expiry
     *      too: the money goes to the same place a refund would send it.
     *
     *      The signature is checked the way AUSD checks the sender's
     *      authorization, so any sender that could fund a link can also
     *      cancel it, a smart account included. See `_signedBySender`.
     */
    function cancel(address linkKey, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        Link memory link = links[linkKey];
        if (link.sender == address(0)) revert LinkNotFound();
        _requireLive(deadline);
        if (!_signedBySender(link.sender, cancelDigest(linkKey, deadline), v, r, s)) revert NotSender();

        delete links[linkKey];
        stablecoin.safeTransfer(link.sender, link.amount);

        emit Cancelled(linkKey, link.sender, link.amount);
    }

    /**
     * @notice Return an expired link to its sender. Anyone may call it.
     * @dev Permissionless for the same reason `chargeDue` is on
     *      PolarisPayments: the money can only travel to the sender, so a
     *      stranger calling it is harmless, and the sender does not have to be
     *      online, or hold gas, to get their money back.
     */
    function refund(address linkKey) external nonReentrant {
        Link memory link = links[linkKey];
        if (link.sender == address(0)) revert LinkNotFound();
        if (block.timestamp < link.expiresAt) revert NotExpired();

        delete links[linkKey];
        stablecoin.safeTransfer(link.sender, link.amount);

        emit Refunded(linkKey, link.sender, link.amount);
    }

    // -----------------------------------------------------------------
    // Views for clients
    // -----------------------------------------------------------------

    function linkOf(address linkKey) external view returns (Link memory) {
        return links[linkKey];
    }

    /// @notice The digest the link key signs to open a link for `sender`.
    function openDigest(address sender, uint256 amount, uint64 expiresAt) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(OPEN_TYPEHASH, sender, amount, expiresAt)));
    }

    /// @notice The digest the link key signs to claim to `to`.
    function claimDigest(address to, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, to, deadline)));
    }

    /// @notice The digest the sender signs to cancel `linkKey`.
    function cancelDigest(address linkKey, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, linkKey, deadline)));
    }

    /**
     * @notice The ERC-3009 nonce a sender must sign for this link.
     * @dev Exposed so the app derives the nonce from the same code that checks
     *      it, rather than from a copy that could drift.
     */
    function sendNonce(address linkKey, uint64 expiresAt) public pure returns (bytes32) {
        return keccak256(abi.encode(linkKey, expiresAt));
    }

    // -----------------------------------------------------------------

    /// Every check `send` makes before it touches state. Split out of `send`
    /// only because its twelve arguments leave no stack room to inline them.
    function _checkSend(
        address sender,
        address linkKey,
        uint256 amount,
        uint64 expiresAt,
        uint256 validBefore,
        uint8 keyV,
        bytes32 keyR,
        bytes32 keyS
    ) private view {
        if (linkKey == address(0) || sender == address(0)) revert ZeroAddress();
        if (keyUsed[linkKey]) revert LinkKeyUsed();
        if (amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        if (expiresAt < block.timestamp + MIN_LIFETIME || expiresAt > block.timestamp + MAX_EXPIRY) {
            revert InvalidExpiry();
        }
        _requireShortLived(validBefore);
        // `linkKey` is not zero, so a signature that fails to recover (and
        // yields the zero address) can never match it.
        if (_recover(openDigest(sender, amount, expiresAt), keyV, keyR, keyS) != linkKey) {
            revert InvalidOpenSignature();
        }
    }

    /// Pull the sender's authorized amount and check what actually arrived,
    /// measured rather than assumed, so a token that delivers less than it
    /// was asked to cannot leave a link promising more than the escrow holds.
    function _pull(
        address sender,
        address linkKey,
        uint256 amount,
        uint64 expiresAt,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        bytes32 nonce = sendNonce(linkKey, expiresAt);
        uint256 balanceBefore = stablecoin.balanceOf(address(this));
        IERC3009(address(stablecoin)).receiveWithAuthorization(
            sender, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );
        uint256 received = stablecoin.balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert UnexpectedAmount(amount, received);
    }

    /// Refuse a signature whose deadline has passed, or is further out than
    /// MAX_SIGNATURE_WINDOW.
    function _requireLive(uint256 deadline) private view {
        if (block.timestamp > deadline) revert SignatureExpired();
        _requireShortLived(deadline);
    }

    /// Refuse a signature that would stay usable for more than
    /// MAX_SIGNATURE_WINDOW from now.
    function _requireShortLived(uint256 cutoff) private view {
        if (cutoff > block.timestamp + MAX_SIGNATURE_WINDOW) revert SignatureWindowTooLong();
    }

    /// True if `sender` signed `digest`: an ECDSA signature from the sender's
    /// own key or, for an account with code, one its ERC-1271
    /// `isValidSignature` accepts for the same r, s, v packed into 65 bytes.
    /// That is how AUSD verifies the sender's `ReceiveWithAuthorization`, so a
    /// smart account (a Safe, say) that funded a link can cancel it rather
    /// than wait up to 30 days for a refund. ECDSA is tried first so that an
    /// EOA which has since delegated its code (EIP-7702) still cancels with
    /// its own key. The ERC-1271 call is a staticcall: the account can refuse,
    /// but it cannot change state or reenter.
    function _signedBySender(address sender, bytes32 digest, uint8 v, bytes32 r, bytes32 s)
        private
        view
        returns (bool)
    {
        if (_recover(digest, v, r, s) == sender) return true;
        return sender.code.length != 0
            && SignatureChecker.isValidERC1271SignatureNow(sender, digest, abi.encodePacked(r, s, v));
    }

    /// Recover a signer without reverting, so a malformed signature is refused
    /// with this contract's own error rather than the library's.
    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) private pure returns (address signer) {
        (signer,,) = ECDSA.tryRecover(digest, v, r, s);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPolarisPaymentsLike} from "./interfaces/IPolaris.sol";
import {IMessageTransmitterV2} from "./interfaces/ITokenMessengerV2.sol";

/**
 * @title PolarisCctpHookReceiver
 * @notice Pay a Polaris order from any CCTP chain with one transaction there,
 *         using CCTP V2 hooks (no CCIP, no second message): the buyer calls
 *         `TokenMessengerV2.depositForBurnWithHook` on the source chain with
 *           mintRecipient     = this contract,
 *           destinationCaller = this contract (so only it can finish the
 *                               transfer, and it always runs the hook), and
 *           hookData          = abi.encode(merchant, orderId, orderAmount, refundTo).
 *         On Arc anyone (the Polaris relayer) calls `relay(message,
 *         attestation)`: this contract receives the mint through
 *         MessageTransmitterV2, then pays the order with
 *         `PolarisPayments.pay(merchant, orderAmount, orderId)` and sends any
 *         excess to `refundTo`. If the order can't take the payment, all of it
 *         goes to `refundTo` on Arc.
 * @dev Holds nothing between calls: what one relay mints, the same call pays
 *      out. Ownerless. The mint amount is measured as the balance change around
 *      `receiveMessage`, so CCTP's fast-transfer fee is accounted for.
 */
contract PolarisCctpHookReceiver is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IMessageTransmitterV2 public immutable messageTransmitter;
    IPolarisPaymentsLike public immutable payments;
    uint32 public immutable arcDomain;

    /// MessageV2 header: version 4, sourceDomain 4, destinationDomain 4, nonce 32, sender 32, recipient 32,
    /// destinationCaller 32, minFinalityThreshold 4, finalityThresholdExecuted 4 = 148 bytes, then the body.
    uint256 private constant BODY = 148;
    /// BurnMessageV2: version 4, burnToken 32, mintRecipient 32, amount 32, messageSender 32, maxFee 32,
    /// feeExecuted 32, expirationBlock 32 = 228 bytes, then hookData.
    uint256 private constant HOOK = BODY + 228;

    event HookPayment(bytes32 indexed nonce, address indexed merchant, address indexed refundTo, uint32 sourceDomain, string orderId, uint256 amount, uint256 excess, bytes32 paymentId);
    event HookRefund(bytes32 indexed nonce, address indexed refundTo, uint32 sourceDomain, uint256 amount, bytes reason);

    error NotForArc(uint32 destinationDomain);
    error NotForThis();
    error ReceiveFailed();
    error ZeroAddress();
    error InsufficientGas();

    constructor(IERC20 _usdc, IMessageTransmitterV2 _messageTransmitter, IPolarisPaymentsLike _payments, uint32 _arcDomain) {
        if (address(_usdc) == address(0) || address(_messageTransmitter) == address(0) || address(_payments) == address(0)) revert ZeroAddress();
        usdc = _usdc;
        messageTransmitter = _messageTransmitter;
        payments = _payments;
        arcDomain = _arcDomain;
        _usdc.approve(address(_payments), type(uint256).max);
    }

    /// @notice The order a CCTP V2 message carries (for the app and the relayer). Reverts on a message not for this contract.
    function decode(bytes calldata message)
        public
        view
        returns (bytes32 nonce, uint32 sourceDomain, address merchant, string memory orderId, uint256 orderAmount, address refundTo)
    {
        uint32 destinationDomain = uint32(bytes4(message[8:12]));
        if (destinationDomain != arcDomain) revert NotForArc(destinationDomain);
        if (address(uint160(uint256(bytes32(message[108:140])))) != address(this)) revert NotForThis(); // destinationCaller
        if (address(uint160(uint256(bytes32(message[BODY + 36:BODY + 68])))) != address(this)) revert NotForThis(); // mintRecipient
        nonce = bytes32(message[12:44]);
        sourceDomain = uint32(bytes4(message[4:8]));
        (merchant, orderId, orderAmount, refundTo) = abi.decode(message[HOOK:], (address, string, uint256, address));
        if (refundTo == address(0)) refundTo = address(uint160(uint256(bytes32(message[BODY + 100:BODY + 132])))); // messageSender
    }

    /// @notice Finish a hooked CCTP transfer on Arc and pay the order it names.
    function relay(bytes calldata message, bytes calldata attestation) external nonReentrant returns (bytes32 paymentId) {
        (bytes32 nonce, uint32 sourceDomain, address merchant, string memory orderId, uint256 orderAmount, address refundTo) = decode(message);
        uint256 before = usdc.balanceOf(address(this));
        if (!messageTransmitter.receiveMessage(message, attestation)) revert ReceiveFailed();
        uint256 minted = usdc.balanceOf(address(this)) - before;

        if (merchant != address(0) && orderAmount != 0 && minted >= orderAmount) {
            uint256 gasBefore = gasleft();
            try payments.pay(merchant, orderAmount, orderId) returns (bytes32 id) {
                paymentId = id;
                uint256 excess = minted - orderAmount;
                if (excess != 0) usdc.safeTransfer(refundTo, excess);
                emit HookPayment(nonce, merchant, refundTo, sourceDomain, orderId, orderAmount, excess, id);
                return id;
            } catch (bytes memory reason) {
                // A starved call must not turn a payment into a refund (relay is permissionless).
                if (gasleft() <= gasBefore / 63) revert InsufficientGas();
                usdc.safeTransfer(refundTo, minted);
                emit HookRefund(nonce, refundTo, sourceDomain, minted, reason);
                return bytes32(0);
            }
        }
        // Less than the order (a fast transfer whose fee came out of it) or no order: the dollars are the buyer's, on Arc.
        usdc.safeTransfer(refundTo, minted);
        emit HookRefund(nonce, refundTo, sourceDomain, minted, "");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";
import {PolarisCCIPIntent} from "./PolarisCCIPIntent.sol";

/**
 * @title PolarisCCIPSender
 * @notice Deployed on a source chain (Base, Ethereum, Polygon…): pay a Polaris
 *         order on Arc, or repay a Pay in 4 instalment, with USDC held there.
 *         One call does both halves:
 *           1. Circle CCTP V2 burns the USDC here and mints it on Arc to
 *              PolarisCCIPReceiver (standard transfer: no fee, the full amount
 *              arrives);
 *           2. Chainlink CCIP carries the intent (merchant, order, or loan) to
 *              that receiver.
 *         The CCIP fee is paid in the source chain's native coin (`msg.value`;
 *         `feeToken = address(0)`), any excess refunded.
 * @dev Ownerless: every destination parameter is immutable, so the contract can
 *      only ever send to the one Arc receiver it was built for.
 */
contract PolarisCCIPSender is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IRouterClient public immutable router;
    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;
    /// Arc's CCIP chain selector and CCTP domain (26), and the receiver there.
    uint64 public immutable arcChainSelector;
    uint32 public immutable arcCctpDomain;
    address public immutable arcReceiver;
    /// Gas for the receiver's `ccipReceive` on Arc (record + settle a payment).
    uint256 public immutable destinationGasLimit;

    /// CCTP V2 standard transfer: wait for the source chain's finality, no fee.
    uint32 public constant CCTP_STANDARD_FINALITY = 2000;

    event PaySent(bytes32 indexed messageId, address indexed payer, address indexed merchant, string orderId, uint256 amount, uint256 ccipFee);
    event RepaySent(bytes32 indexed messageId, address indexed payer, address indexed borrower, uint256 loanId, uint256 amount, uint256 ccipFee);

    error InvalidAmount(uint256 amount);
    error ZeroAddress();
    error InsufficientFee(uint256 sent, uint256 fee);
    error RefundFailed();

    constructor(
        IRouterClient _router,
        IERC20 _usdc,
        ITokenMessengerV2 _tokenMessenger,
        uint64 _arcChainSelector,
        uint32 _arcCctpDomain,
        address _arcReceiver,
        uint256 _destinationGasLimit
    ) {
        if (address(_router) == address(0) || address(_usdc) == address(0) || address(_tokenMessenger) == address(0) || _arcReceiver == address(0)) {
            revert ZeroAddress();
        }
        router = _router;
        usdc = _usdc;
        tokenMessenger = _tokenMessenger;
        arcChainSelector = _arcChainSelector;
        arcCctpDomain = _arcCctpDomain;
        arcReceiver = _arcReceiver;
        destinationGasLimit = _destinationGasLimit;
    }

    // -----------------------------------------------------------------
    // Pay a Polaris order on Arc
    // -----------------------------------------------------------------

    function quotePay(address merchant, uint256 amount, string calldata orderId, address arcRefundTo) external view returns (uint256) {
        return router.getFee(arcChainSelector, _message(_payData(msg.sender, merchant, amount, orderId, arcRefundTo)));
    }

    /**
     * @notice Pay `orderId` at `merchant` on Arc with `amount` of this chain's
     *         USDC (approve this contract first). If the order can't take the
     *         payment on Arc, the dollars go to `arcRefundTo` there.
     */
    function payOnArc(address merchant, uint256 amount, string calldata orderId, address arcRefundTo)
        external
        payable
        nonReentrant
        returns (bytes32 messageId)
    {
        if (merchant == address(0) || arcRefundTo == address(0)) revert ZeroAddress();
        _burnToArc(amount);
        uint256 fee;
        (messageId, fee) = _send(_payData(msg.sender, merchant, amount, orderId, arcRefundTo));
        emit PaySent(messageId, msg.sender, merchant, orderId, amount, fee);
    }

    // -----------------------------------------------------------------
    // Repay a Pay in 4 plan on Arc
    // -----------------------------------------------------------------

    function quoteRepay(address borrower, uint256 loanId, uint256 amount) external view returns (uint256) {
        return router.getFee(arcChainSelector, _message(_repayData(msg.sender, borrower, loanId, amount)));
    }

    /// @notice Send `amount` to `borrower` on Arc and collect their due instalment of `loanId`.
    function repayOnArc(address borrower, uint256 loanId, uint256 amount) external payable nonReentrant returns (bytes32 messageId) {
        if (borrower == address(0)) revert ZeroAddress();
        _burnToArc(amount);
        uint256 fee;
        (messageId, fee) = _send(_repayData(msg.sender, borrower, loanId, amount));
        emit RepaySent(messageId, msg.sender, borrower, loanId, amount, fee);
    }

    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------

    function _burnToArc(uint256 amount) private {
        if (amount == 0 || amount > PolarisCCIPIntent.MAX_AMOUNT) revert InvalidAmount(amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.forceApprove(address(tokenMessenger), amount);
        tokenMessenger.depositForBurn(
            amount,
            arcCctpDomain,
            bytes32(uint256(uint160(arcReceiver))),
            address(usdc),
            bytes32(0), // anyone may finish the mint on Arc (the Polaris relayer does)
            0, // standard transfer: no fee
            CCTP_STANDARD_FINALITY
        );
    }

    function _send(bytes memory data) private returns (bytes32 messageId, uint256 fee) {
        Client.EVM2AnyMessage memory m = _message(data);
        fee = router.getFee(arcChainSelector, m);
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);
        messageId = router.ccipSend{value: fee}(arcChainSelector, m);
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _message(bytes memory data) private view returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(arcReceiver),
            data: data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            extraArgs: Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: destinationGasLimit, allowOutOfOrderExecution: true})),
            feeToken: address(0)
        });
    }

    function _payData(address payer, address merchant, uint256 amount, string calldata orderId, address arcRefundTo) private pure returns (bytes memory) {
        return abi.encode(
            PolarisCCIPIntent.KIND_PAY,
            abi.encode(PolarisCCIPIntent.PayIntent({sourcePayer: payer, arcRefundTo: arcRefundTo, merchant: merchant, orderId: orderId, amount: amount}))
        );
    }

    function _repayData(address payer, address borrower, uint256 loanId, uint256 amount) private pure returns (bytes memory) {
        return abi.encode(
            PolarisCCIPIntent.KIND_REPAY,
            abi.encode(PolarisCCIPIntent.RepayIntent({sourcePayer: payer, borrower: borrower, loanId: loanId, amount: amount}))
        );
    }
}

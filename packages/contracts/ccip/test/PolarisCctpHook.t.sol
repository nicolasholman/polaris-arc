// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockUSDC} from "../../contracts/MockUSDC.sol";
import {PolarisPayments} from "../../contracts/PolarisPayments.sol";

import {PolarisCctpHookReceiver} from "../src/PolarisCctpHookReceiver.sol";
import {IMessageTransmitterV2} from "../src/interfaces/ITokenMessengerV2.sol";
import {IPolarisPaymentsLike} from "../src/interfaces/IPolaris.sol";
import {MockMessageTransmitterV2} from "./mocks/MockMessageTransmitterV2.sol";

/**
 * Pay a Polaris order with one CCTP V2 transfer and a hook: the message is
 * built byte for byte in CCTP V2's layout (MessageV2 + BurnMessageV2 with
 * hookData), the transmitter stands in for Circle's on Arc.
 */
contract PolarisCctpHookTest is Test {
    MockUSDC internal usdc;
    MockMessageTransmitterV2 internal transmitter;
    PolarisPayments internal payments;
    PolarisCctpHookReceiver internal hook;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal merchant = makeAddr("merchant");
    address internal buyerOnBase = makeAddr("buyer on Base");
    address internal buyerOnArc = makeAddr("buyer on Arc");
    uint64 internal nonceSeq;

    function setUp() public {
        usdc = new MockUSDC("USDC");
        transmitter = new MockMessageTransmitterV2(IERC20(address(usdc)));
        usdc.transfer(address(transmitter), 1_000_000e6);
        payments = new PolarisPayments(owner, usdc, treasury, 60);
        hook = new PolarisCctpHookReceiver(IERC20(address(usdc)), IMessageTransmitterV2(address(transmitter)), IPolarisPaymentsLike(address(payments)), 26);
    }

    function _message(uint32 destDomain, address caller, address recipient, uint256 amount, uint256 feeExecuted, bytes memory hookData)
        internal
        returns (bytes memory)
    {
        bytes memory body = abi.encodePacked(
            uint32(1), // BurnMessageV2 version
            bytes32(uint256(uint160(0x036CbD53842c5426634e7929541eC2318f3dCF7e))), // burnToken (USDC on Base Sepolia)
            bytes32(uint256(uint160(recipient))), // mintRecipient
            amount,
            bytes32(uint256(uint160(buyerOnBase))), // messageSender
            uint256(feeExecuted), // maxFee
            feeExecuted,
            uint256(0), // expirationBlock
            hookData
        );
        return abi.encodePacked(
            uint32(1), // MessageV2 version
            uint32(6), // source: Base
            destDomain,
            bytes32(uint256(++nonceSeq)),
            bytes32(uint256(uint160(makeAddr("TokenMessengerV2 on Base")))),
            bytes32(uint256(uint160(makeAddr("TokenMessengerV2 on Arc")))),
            bytes32(uint256(uint160(caller))), // destinationCaller
            uint32(2000),
            uint32(2000),
            body
        );
    }

    function _order(string memory orderId, uint256 orderAmount, address refundTo) internal view returns (bytes memory) {
        return abi.encode(merchant, orderId, orderAmount, refundTo);
    }

    function test_OneTransferPaysTheOrder_andSendsTheExcessToTheBuyer() public {
        bytes memory m = _message(26, address(hook), address(hook), 30e6, 0, _order("order-1", 25e6, buyerOnArc));
        (, uint32 src, address mer, string memory orderId, uint256 amt, address refundTo) = hook.decode(m);
        assertEq(src, 6);
        assertEq(mer, merchant);
        assertEq(orderId, "order-1");
        assertEq(amt, 25e6);
        assertEq(refundTo, buyerOnArc);
        bytes32 paymentId = hook.relay(m, "");
        assertEq(paymentId, keccak256(abi.encodePacked(merchant, "order-1")));
        assertEq(usdc.balanceOf(merchant), 25e6 - 125_000); // PolarisPayments' 0.5%
        assertEq(usdc.balanceOf(buyerOnArc), 5e6);
        assertEq(usdc.balanceOf(address(hook)), 0);
        // The same message can't be relayed twice.
        vm.expectRevert(bytes("Nonce already used"));
        hook.relay(m, "");
    }

    function test_AnOrderAlreadyPaid_refundsEverythingOnArc() public {
        hook.relay(_message(26, address(hook), address(hook), 25e6, 0, _order("order-2", 25e6, buyerOnArc)), "");
        hook.relay(_message(26, address(hook), address(hook), 25e6, 0, _order("order-2", 25e6, buyerOnArc)), "");
        assertEq(usdc.balanceOf(buyerOnArc), 25e6);
        assertEq(usdc.balanceOf(address(hook)), 0);
    }

    function test_AFastTransferWhoseFeeLeftTooLittle_refunds_andNoRefundAddressMeansTheBurner() public {
        hook.relay(_message(26, address(hook), address(hook), 25e6, 10_000, _order("order-3", 25e6, address(0))), "");
        assertEq(usdc.balanceOf(merchant), 0);
        assertEq(usdc.balanceOf(buyerOnBase), 25e6 - 10_000);
    }

    function test_RefusesMessagesNotForIt() public {
        vm.expectRevert(abi.encodeWithSelector(PolarisCctpHookReceiver.NotForArc.selector, uint32(6)));
        hook.relay(_message(6, address(hook), address(hook), 1e6, 0, _order("x", 1e6, buyerOnArc)), "");
        vm.expectRevert(PolarisCctpHookReceiver.NotForThis.selector);
        hook.relay(_message(26, address(0), address(hook), 1e6, 0, _order("x", 1e6, buyerOnArc)), "");
        vm.expectRevert(PolarisCctpHookReceiver.NotForThis.selector);
        hook.relay(_message(26, address(hook), buyerOnArc, 1e6, 0, _order("x", 1e6, buyerOnArc)), "");
    }

    function test_AStarvedRelayRevertsInsteadOfRefunding() public {
        bytes memory m = _message(26, address(hook), address(hook), 25e6, 0, _order("order-4", 25e6, buyerOnArc));
        (bool ok,) = address(hook).call{gas: 160_000}(abi.encodeCall(hook.relay, (m, "")));
        assertFalse(ok);
        assertEq(usdc.balanceOf(buyerOnArc), 0);
        hook.relay(m, ""); // with enough gas it pays
        assertEq(usdc.balanceOf(merchant), 25e6 - 125_000);
    }
}

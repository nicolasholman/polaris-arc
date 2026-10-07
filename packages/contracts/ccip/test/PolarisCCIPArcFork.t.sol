// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PolarisPayments} from "../../contracts/PolarisPayments.sol";
import {PolarisCCIPReceiver} from "../src/PolarisCCIPReceiver.sol";
import {PolarisCCIPIntent} from "../src/PolarisCCIPIntent.sol";
import {IPolarisLoanEngineLike, IPolarisPaymentsLike} from "../src/interfaces/IPolaris.sol";

/**
 * Against a fork of Arc testnet: Chainlink's real CCIP router on Arc, Circle's
 * real USDC (0x3600…0000, the native gas balance seen as a 6-decimal ERC-20).
 * Run with ARC_FORK_TESTS=1 (it reads https://rpc.testnet.arc.io). Arc's
 * native USDC moves only on Arc Foundry's anvil, so this test reads the real
 * router and delivers as it would, and funds the receiver by `deal` on the
 * ERC-20 view only where the local EVM allows; the full money path runs in
 * PolarisCCIP.t.sol and in scripts/arc-fork.sh's rehearsal.
 */
contract PolarisCCIPArcForkTest is Test {
    address constant ARC_TESTNET_ROUTER = 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8;
    address constant USDC = 0x3600000000000000000000000000000000000000;
    uint64 constant BASE_SEPOLIA = 10344971235874465080;
    uint64 constant ETHEREUM_SEPOLIA = 16015286601757825753;

    function setUp() public {
        if (!vm.envOr("ARC_FORK_TESTS", false)) vm.skip(true);
        vm.createSelectFork("arc_testnet");
    }

    function test_ArcTestnetRouter_hasTheLanesPolarisUses() public view {
        IRouterClient router = IRouterClient(ARC_TESTNET_ROUTER);
        assertTrue(router.isChainSupported(BASE_SEPOLIA));
        assertTrue(router.isChainSupported(ETHEREUM_SEPOLIA));
    }

    function test_FeesOnArcArePaidInNativeUSDC() public view {
        // An Arc -> Base Sepolia message priced in the native coin (feeToken = 0): USDC on Arc.
        Client.EVM2AnyMessage memory m = Client.EVM2AnyMessage({
            receiver: abi.encode(address(0xBEEF)),
            data: abi.encode(uint8(1), bytes("")),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            extraArgs: Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: 200_000, allowOutOfOrderExecution: true})),
            feeToken: address(0)
        });
        uint256 fee = IRouterClient(ARC_TESTNET_ROUTER).getFee(BASE_SEPOLIA, m);
        assertGt(fee, 0);
        // 18-decimal native USDC: a fee of well under a dollar.
        assertLt(fee, 1e18);
    }

    function test_TheRealRouterDelivers_andOnlyItMay() public {
        PolarisPayments payments = new PolarisPayments(address(this), IERC20(USDC), address(this), 3600);
        PolarisCCIPReceiver receiver = new PolarisCCIPReceiver(
            ARC_TESTNET_ROUTER, IERC20(USDC), IPolarisPaymentsLike(address(payments)), IPolarisLoanEngineLike(address(0xdead)), address(this)
        );
        address senderOnBase = address(0x5E4D);
        receiver.allowSender(BASE_SEPOLIA, senderOnBase, true);
        assertEq(receiver.getRouter(), ARC_TESTNET_ROUTER);

        bytes memory body = abi.encode(
            PolarisCCIPIntent.PayIntent({sourcePayer: senderOnBase, arcRefundTo: address(0xA11CE), merchant: address(0xB0B), orderId: "fork-1", amount: 3e6})
        );
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256("fork-1"),
            sourceChainSelector: BASE_SEPOLIA,
            sender: abi.encode(senderOnBase),
            data: abi.encode(PolarisCCIPIntent.KIND_PAY, body),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.expectRevert();
        receiver.ccipReceive(m);
        vm.prank(ARC_TESTNET_ROUTER);
        receiver.ccipReceive(m);
        (, PolarisCCIPReceiver.Status status, uint256 amount,,) = receiver.intentOf(keccak256("fork-1"));
        // No CCTP mint on this fork: the intent waits for its dollars.
        assertEq(uint8(status), uint8(PolarisCCIPReceiver.Status.Pending));
        assertEq(amount, 3e6);
    }
}

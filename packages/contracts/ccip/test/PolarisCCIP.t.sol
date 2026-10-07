// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CCIPLocalSimulator, IRouterClient} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockUSDC} from "../../contracts/MockUSDC.sol";
import {PolarisPayments} from "../../contracts/PolarisPayments.sol";
import {PolarisLoanEngine} from "../../contracts/PolarisLoanEngine.sol";
import {ScoreManager} from "../../contracts/ScoreManager.sol";

import {PolarisCCIPReceiver} from "../src/PolarisCCIPReceiver.sol";
import {PolarisCCIPSender} from "../src/PolarisCCIPSender.sol";
import {PolarisCCIPIntent} from "../src/PolarisCCIPIntent.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";
import {IPolarisLoanEngineLike, IPolarisPaymentsLike} from "../src/interfaces/IPolaris.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";

/**
 * Pay a Polaris order on Arc, and repay a plan, from another chain: CCTP V2
 * moves the USDC (MockTokenMessengerV2 stands in for burn and mint), Chainlink
 * CCIP carries the intent (Chainlink Local's CCIPLocalSimulator routes the
 * message for real through its router, onlyRouter and all).
 */
contract PolarisCCIPTest is Test {
    CCIPLocalSimulator internal sim;
    IRouterClient internal router;
    uint64 internal selector;

    MockUSDC internal usdc;
    MockTokenMessengerV2 internal cctp;
    PolarisPayments internal payments;
    ScoreManager internal scores;
    PolarisLoanEngine internal engine;
    PolarisCCIPReceiver internal receiver;
    PolarisCCIPSender internal sender;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal merchant = makeAddr("merchant");
    address internal payer = makeAddr("payer on Base");
    address internal buyerOnArc = makeAddr("buyer on Arc");

    function setUp() public {
        sim = new CCIPLocalSimulator();
        (uint64 chainSelector, IRouterClient sourceRouter, IRouterClient destinationRouter,,,,) = sim.configuration();
        selector = chainSelector;
        router = sourceRouter;

        usdc = new MockUSDC("USDC");
        cctp = new MockTokenMessengerV2(IERC20(address(usdc)));
        payments = new PolarisPayments(owner, usdc, treasury, 60);
        scores = new ScoreManager(owner);
        engine = new PolarisLoanEngine(owner, usdc, scores, treasury, 1 days, 60);
        vm.startPrank(owner);
        scores.setWriter(address(engine), true);
        engine.setOriginator(address(this), true);
        vm.stopPrank();
        usdc.approve(address(engine), type(uint256).max);
        vm.prank(owner);
        engine.fund(0); // no-op guard: funded below from this contract
        usdc.transfer(owner, 100_000e6);
        vm.startPrank(owner);
        usdc.approve(address(engine), type(uint256).max);
        engine.fund(50_000e6);
        vm.stopPrank();

        receiver = new PolarisCCIPReceiver(
            address(destinationRouter), IERC20(address(usdc)), IPolarisPaymentsLike(address(payments)), IPolarisLoanEngineLike(address(engine)), owner
        );
        sender = new PolarisCCIPSender(sourceRouter, IERC20(address(usdc)), ITokenMessengerV2(address(cctp)), selector, 26, address(receiver), 600_000);
        vm.prank(owner);
        receiver.allowSender(selector, address(sender), true);

        usdc.mint(payer, 1_000e6);
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        usdc.approve(address(sender), type(uint256).max);
    }

    function _pay(uint256 amount, string memory orderId) internal returns (bytes32 id) {
        uint256 fee = sender.quotePay(merchant, amount, orderId, buyerOnArc);
        vm.prank(payer);
        id = sender.payOnArc{value: fee + 0.01 ether}(merchant, amount, orderId, buyerOnArc);
    }

    function _status(bytes32 id) internal view returns (PolarisCCIPReceiver.Status s) {
        (, s,,,) = receiver.intentOf(id);
    }

    function test_PayFromAnotherChain_settlesTheOrderOnArc() public {
        uint256 payerEthBefore = payer.balance;
        bytes32 id = _pay(25e6, "order-1");
        assertEq(uint8(_status(id)), uint8(PolarisCCIPReceiver.Status.Settled));
        // The merchant is paid exactly as by a checkout: the price less PolarisPayments' 0.5% fee.
        assertEq(usdc.balanceOf(merchant), 25e6 - 125_000);
        assertEq(usdc.balanceOf(treasury), 125_000);
        (address recordedPayer,, uint128 amount,) = payments.payments(keccak256(abi.encodePacked(merchant, "order-1")));
        assertEq(recordedPayer, address(receiver));
        assertEq(amount, 25e6);
        // CCTP: a standard transfer to Arc (domain 26), no fee, anyone may finish the mint.
        assertEq(cctp.lastDestinationDomain(), 26);
        assertEq(cctp.lastMinFinality(), 2000);
        assertEq(cctp.lastMaxFee(), 0);
        assertEq(cctp.lastDestinationCaller(), bytes32(0));
        // The excess CCIP fee came back.
        assertEq(payer.balance, payerEthBefore);
        assertEq(usdc.balanceOf(address(receiver)), 0);
        assertEq(receiver.pendingTotal(), 0);
    }

    function test_IntentBeforeTheDollars_waitsThenSettles() public {
        cctp.setDeferred(true);
        bytes32 id = _pay(40e6, "order-2");
        assertEq(uint8(_status(id)), uint8(PolarisCCIPReceiver.Status.Pending));
        assertEq(receiver.pendingTotal(), 40e6);
        vm.expectRevert(abi.encodeWithSelector(PolarisCCIPReceiver.NotFunded.selector, 0, 40e6));
        receiver.settle(id);
        cctp.releaseAll(); // the CCTP mint lands on Arc
        vm.prank(makeAddr("anyone"));
        receiver.settle(id);
        assertEq(uint8(_status(id)), uint8(PolarisCCIPReceiver.Status.Settled));
        assertEq(usdc.balanceOf(merchant), 40e6 - 200_000);
        vm.expectRevert(abi.encodeWithSelector(PolarisCCIPReceiver.NotPending.selector, id));
        receiver.settle(id);
    }

    function test_AnOrderAlreadyPaid_refundsTheBuyerOnArc() public {
        _pay(10e6, "order-3");
        bytes32 second = _pay(10e6, "order-3");
        assertEq(uint8(_status(second)), uint8(PolarisCCIPReceiver.Status.Refunded));
        assertEq(usdc.balanceOf(buyerOnArc), 10e6);
        assertEq(usdc.balanceOf(address(receiver)), 0);
    }

    function test_AQuotedPrice_isEnforced_andAMismatchIsRefunded() public {
        bytes32 key = keccak256(abi.encodePacked(merchant, "order-4"));
        vm.prank(owner);
        payments.setOperator(owner, true);
        vm.prank(owner);
        payments.quoteOrder(merchant, key, 30e6);
        bytes32 id = _pay(29e6, "order-4");
        assertEq(uint8(_status(id)), uint8(PolarisCCIPReceiver.Status.Refunded));
        assertEq(usdc.balanceOf(buyerOnArc), 29e6);
        bytes32 ok = _pay(30e6, "order-4");
        assertEq(uint8(_status(ok)), uint8(PolarisCCIPReceiver.Status.Settled));
    }

    function test_RepayFromAnotherChain_creditsTheBorrowerAndCollects() public {
        address borrower = makeAddr("borrower");
        vm.prank(borrower);
        usdc.approve(address(engine), type(uint256).max);
        uint256 loanId = engine.createLoan(borrower, merchant, 100e6, 4, 1 days);
        vm.warp(block.timestamp + 1 days);
        assertTrue(engine.isInstallmentDue(loanId));
        uint256 due = engine.installmentAmount(loanId);

        uint256 fee = sender.quoteRepay(borrower, loanId, due);
        vm.prank(payer);
        bytes32 id = sender.repayOnArc{value: fee}(borrower, loanId, due);
        assertEq(uint8(_status(id)), uint8(PolarisCCIPReceiver.Status.Settled));
        assertEq(engine.getLoan(loanId).installmentsPaid, 1);
        assertEq(usdc.balanceOf(borrower), 0); // credited, then collected
    }

    function test_OnlyTheAllowlistedSenderOnTheAllowlistedChain() public {
        vm.prank(owner);
        receiver.allowSender(selector, address(sender), false);
        uint256 fee = sender.quotePay(merchant, 5e6, "order-5", buyerOnArc);
        vm.prank(payer);
        vm.expectRevert(); // the router delivers, the receiver refuses: the whole send reverts locally
        sender.payOnArc{value: fee}(merchant, 5e6, "order-5", buyerOnArc);

        // And only the router may call ccipReceive at all.
        Client.Any2EVMMessage memory m;
        vm.expectRevert();
        receiver.ccipReceive(m);
    }

    function test_AMalformedMessage_isStoredAsFailed_notLost() public {
        // An allowlisted sender sends something that doesn't decode as an intent.
        address raw = makeAddr("raw sender");
        vm.prank(owner);
        receiver.allowSender(selector, raw, true);
        vm.deal(raw, 1 ether);
        Client.EVM2AnyMessage memory m = Client.EVM2AnyMessage({
            receiver: abi.encode(address(receiver)),
            data: abi.encode(uint8(9), bytes("")),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            extraArgs: Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: 600_000, allowOutOfOrderExecution: true})),
            feeToken: address(0)
        });
        uint256 fee = router.getFee(selector, m);
        vm.prank(raw);
        bytes32 id = router.ccipSend{value: fee}(selector, m);
        assertEq(uint8(_status(id)), uint8(PolarisCCIPReceiver.Status.Failed));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolarisCCIPReceiver.UnknownKind.selector, 9));
        receiver.retryFailed(id);
    }

    function test_EachIntentIsCapped() public {
        usdc.mint(payer, 20_000e6);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PolarisCCIPSender.InvalidAmount.selector, 10_000e6 + 1));
        sender.payOnArc(merchant, 10_000e6 + 1, "big", buyerOnArc);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PolarisCCIPSender.InvalidAmount.selector, 0));
        sender.payOnArc(merchant, 0, "zero", buyerOnArc);
    }

    function test_OnlyTheOwnerEditsTheAllowlist() public {
        vm.expectRevert();
        receiver.allowSender(selector, address(this), true);
    }

    function test_AStarvedSettle_neverTurnsAPaymentIntoARefund() public {
        cctp.setDeferred(true);
        bytes32 id = _pay(15e6, "order-6");
        cctp.releaseAll();
        // Enough gas to reach payments.pay, not enough for it to finish.
        (bool ok,) = address(receiver).call{gas: 120_000}(abi.encodeCall(PolarisCCIPReceiver.settle, (id)));
        assertFalse(ok);
        assertEq(uint8(_status(id)), uint8(PolarisCCIPReceiver.Status.Pending));
        assertEq(usdc.balanceOf(buyerOnArc), 0);
        receiver.settle(id);
        assertEq(uint8(_status(id)), uint8(PolarisCCIPReceiver.Status.Settled));
    }
}

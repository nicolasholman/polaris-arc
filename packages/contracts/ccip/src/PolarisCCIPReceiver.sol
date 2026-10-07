// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPolarisLoanEngineLike, IPolarisPaymentsLike} from "./interfaces/IPolaris.sol";
import {PolarisCCIPIntent} from "./PolarisCCIPIntent.sol";

/**
 * @title PolarisCCIPReceiver
 * @notice Pay a Polaris link, or a Pay in 4 instalment, from another chain.
 *         "CCTP moves the dollars, CCIP carries the instruction": USDC is not
 *         a CCIP token on Arc, so PolarisCCIPSender on the source chain burns
 *         the buyer's USDC with Circle's CCTP V2 (mint recipient: this
 *         contract) and sends the intent here with Chainlink CCIP. This
 *         contract acts once both have arrived, in either order.
 *
 * @dev
 *  - Only allowlisted (source chain selector, sender) pairs are accepted, and
 *    only from the CCIP router (CCIPReceiver).
 *  - Defensive: `_ccipReceive` never reverts on business logic. A message
 *    that can't be decoded or recorded is stored as failed (`retryFailed`);
 *    an intent whose dollars haven't been minted yet is recorded as pending,
 *    and `settle(messageId)` (anyone may call it) completes it once they have.
 *  - PAY: `PolarisPayments.pay(merchant, amount, orderId)` from this
 *    contract's USDC, so the merchant is paid exactly as by a checkout (and
 *    the order is payable once, at its quoted price). If the order can't be
 *    paid, the dollars go to the intent's `arcRefundTo` on Arc, never stuck.
 *  - REPAY: the dollars go to the borrower's Arc account, then the due
 *    instalment is collected (permissionless on the loan engine, drawing on
 *    the allowance the borrower signed when the plan opened). Either way the
 *    dollars are the borrower's.
 *  - Each intent moves at most $10,000. The owner can only edit the
 *    allowlist and retry failed messages; it can't take or redirect funds.
 */
contract PolarisCCIPReceiver is CCIPReceiver, Ownable {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Pending,
        Settled,
        Refunded,
        Failed
    }

    struct Intent {
        uint8 kind;
        Status status;
        uint64 sourceChainSelector;
        address sourceSender;
        uint64 receivedAt;
        bytes body;
    }

    IERC20 public immutable usdc;
    IPolarisPaymentsLike public immutable payments;
    IPolarisLoanEngineLike public immutable loanEngine;

    /// sourceChainSelector => sender => allowed
    mapping(uint64 => mapping(address => bool)) public allowedSenders;
    mapping(bytes32 => Intent) public intents;
    /// USDC set aside for pending intents, in order of arrival: a mint can only settle what it pays for in aggregate.
    uint256 public pendingTotal;
    /// A failed message's raw payload, for `retryFailed` (the message carries no tokens).
    struct Failed {
        uint64 sourceChainSelector;
        bytes sender;
        bytes data;
    }

    mapping(bytes32 => Failed) private _failed;

    event SenderAllowed(uint64 indexed sourceChainSelector, address indexed sender, bool allowed);
    event IntentReceived(bytes32 indexed messageId, uint64 indexed sourceChainSelector, uint8 kind, uint256 amount);
    event CrossChainPayment(
        bytes32 indexed messageId,
        address indexed merchant,
        address indexed sourcePayer,
        uint64 sourceChainSelector,
        string orderId,
        uint256 amount,
        bytes32 paymentId
    );
    event CrossChainRepayment(bytes32 indexed messageId, address indexed borrower, uint256 indexed loanId, uint256 amount, uint256 collected);
    event IntentRefunded(bytes32 indexed messageId, address indexed to, uint256 amount, bytes reason);
    event MessageFailed(bytes32 indexed messageId, bytes reason);
    event MessageRecovered(bytes32 indexed messageId);

    error SourceNotAllowed(uint64 sourceChainSelector, address sender);
    error OnlySelf();
    error UnknownKind(uint8 kind);
    error InvalidAmount(uint256 amount);
    error NotPending(bytes32 messageId);
    error NotFunded(uint256 have, uint256 need);
    error NotFailed(bytes32 messageId);
    error ZeroAddress();
    error InsufficientGas();

    constructor(address router, IERC20 _usdc, IPolarisPaymentsLike _payments, IPolarisLoanEngineLike _loanEngine, address initialOwner)
        CCIPReceiver(router)
        Ownable(initialOwner)
    {
        if (address(_usdc) == address(0) || address(_payments) == address(0) || address(_loanEngine) == address(0)) revert ZeroAddress();
        usdc = _usdc;
        payments = _payments;
        loanEngine = _loanEngine;
        _usdc.forceApprove(address(_payments), type(uint256).max);
    }

    // -----------------------------------------------------------------
    // Owner: the allowlist and failed-message recovery only
    // -----------------------------------------------------------------

    function allowSender(uint64 sourceChainSelector, address sender, bool allowed) external onlyOwner {
        allowedSenders[sourceChainSelector][sender] = allowed;
        emit SenderAllowed(sourceChainSelector, sender, allowed);
    }

    /// @notice Run a failed message again (e.g. after a decoding bug was fixed by allowlisting a corrected sender).
    function retryFailed(bytes32 messageId) external onlyOwner {
        if (intents[messageId].status != Status.Failed) revert NotFailed(messageId);
        Failed memory f = _failed[messageId];
        delete _failed[messageId];
        intents[messageId].status = Status.None;
        this.processMessage(
            Client.Any2EVMMessage({
                messageId: messageId,
                sourceChainSelector: f.sourceChainSelector,
                sender: f.sender,
                data: f.data,
                destTokenAmounts: new Client.EVMTokenAmount[](0)
            })
        );
        emit MessageRecovered(messageId);
    }

    // -----------------------------------------------------------------
    // CCIP
    // -----------------------------------------------------------------

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        address sender = abi.decode(message.sender, (address));
        if (!allowedSenders[message.sourceChainSelector][sender]) revert SourceNotAllowed(message.sourceChainSelector, sender);
        try this.processMessage(message) {
            // Recorded; settle what is funded now, leave the rest pending.
            try this.settle(message.messageId) {} catch {}
        } catch (bytes memory reason) {
            intents[message.messageId] = Intent({
                kind: 0,
                status: Status.Failed,
                sourceChainSelector: message.sourceChainSelector,
                sourceSender: sender,
                receivedAt: uint64(block.timestamp),
                body: ""
            });
            _failed[message.messageId] = Failed({sourceChainSelector: message.sourceChainSelector, sender: message.sender, data: message.data});
            emit MessageFailed(message.messageId, reason);
        }
    }

    /// @notice Decode and record an intent. Only this contract calls it (so `_ccipReceive` can catch a revert).
    function processMessage(Client.Any2EVMMessage calldata message) external {
        if (msg.sender != address(this)) revert OnlySelf();
        (uint8 kind, bytes memory body) = abi.decode(message.data, (uint8, bytes));
        uint256 amount;
        if (kind == PolarisCCIPIntent.KIND_PAY) {
            PolarisCCIPIntent.PayIntent memory p = abi.decode(body, (PolarisCCIPIntent.PayIntent));
            if (p.merchant == address(0) || p.arcRefundTo == address(0)) revert ZeroAddress();
            amount = p.amount;
        } else if (kind == PolarisCCIPIntent.KIND_REPAY) {
            PolarisCCIPIntent.RepayIntent memory r = abi.decode(body, (PolarisCCIPIntent.RepayIntent));
            if (r.borrower == address(0)) revert ZeroAddress();
            amount = r.amount;
        } else {
            revert UnknownKind(kind);
        }
        if (amount == 0 || amount > PolarisCCIPIntent.MAX_AMOUNT) revert InvalidAmount(amount);
        intents[message.messageId] = Intent({
            kind: kind,
            status: Status.Pending,
            sourceChainSelector: message.sourceChainSelector,
            sourceSender: abi.decode(message.sender, (address)),
            receivedAt: uint64(block.timestamp),
            body: body
        });
        pendingTotal += amount;
        emit IntentReceived(message.messageId, message.sourceChainSelector, kind, amount);
    }

    // -----------------------------------------------------------------
    // Settlement: anyone may call it once the CCTP mint has landed
    // -----------------------------------------------------------------

    /// @notice Complete a pending intent with the USDC CCTP minted here. Reverts NotFunded until it has.
    function settle(bytes32 messageId) external {
        Intent storage it = intents[messageId];
        if (it.status != Status.Pending) revert NotPending(messageId);
        uint256 amount = _amountOf(it);
        uint256 have = usdc.balanceOf(address(this));
        if (have < amount) revert NotFunded(have, amount);
        pendingTotal -= amount;

        if (it.kind == PolarisCCIPIntent.KIND_PAY) {
            PolarisCCIPIntent.PayIntent memory p = abi.decode(it.body, (PolarisCCIPIntent.PayIntent));
            uint256 gasBefore = gasleft();
            try payments.pay(p.merchant, p.amount, p.orderId) returns (bytes32 paymentId) {
                it.status = Status.Settled;
                emit CrossChainPayment(messageId, p.merchant, p.sourcePayer, it.sourceChainSelector, p.orderId, p.amount, paymentId);
            } catch (bytes memory reason) {
                // Out of gas is the caller's limit, not the order: never refund for it (anyone may call
                // settle, so a starved call must not turn a payment into a refund).
                if (gasleft() <= gasBefore / 63) revert InsufficientGas();
                // The order can't take this payment (already paid, another price): the dollars go back to the buyer on Arc.
                it.status = Status.Refunded;
                usdc.safeTransfer(p.arcRefundTo, p.amount);
                emit IntentRefunded(messageId, p.arcRefundTo, p.amount, reason);
            }
        } else {
            PolarisCCIPIntent.RepayIntent memory r = abi.decode(it.body, (PolarisCCIPIntent.RepayIntent));
            it.status = Status.Settled;
            usdc.safeTransfer(r.borrower, r.amount);
            uint256 collected;
            if (_due(r.loanId)) {
                try loanEngine.collectInstallment(r.loanId) returns (uint256 c) {
                    collected = c;
                } catch {
                    // The dollars are the borrower's either way; the keeper collects on its next run.
                }
            }
            emit CrossChainRepayment(messageId, r.borrower, r.loanId, r.amount, collected);
        }
    }

    function _due(uint256 loanId) private view returns (bool) {
        try loanEngine.isInstallmentDue(loanId) returns (bool due) {
            return due;
        } catch {
            return false;
        }
    }

    function _amountOf(Intent storage it) private view returns (uint256) {
        if (it.kind == PolarisCCIPIntent.KIND_PAY) return abi.decode(it.body, (PolarisCCIPIntent.PayIntent)).amount;
        return abi.decode(it.body, (PolarisCCIPIntent.RepayIntent)).amount;
    }

    /// @notice An intent's decoded amount and status, for the app and the relayer.
    function intentOf(bytes32 messageId) external view returns (uint8 kind, Status status, uint256 amount, uint64 sourceChainSelector, address sourceSender) {
        Intent storage it = intents[messageId];
        kind = it.kind;
        status = it.status;
        amount = it.status == Status.None || it.status == Status.Failed ? 0 : _amountOf(it);
        sourceChainSelector = it.sourceChainSelector;
        sourceSender = it.sourceSender;
    }
}

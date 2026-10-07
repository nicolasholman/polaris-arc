// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BatchSettlement
 * @notice Pay every merchant owed money in one transaction, each with a memo.
 *
 * @dev Settlement is the part of a payments business that scales badly. Paying
 *      merchants one transaction at a time means one gas cost, one nonce and
 *      one failure mode per merchant per cycle; at a few hundred merchants that
 *      is the dominant operating cost and the dominant source of partial
 *      failure.
 *
 *      Tempo makes atomic batch payout native, with a protocol-level 32-byte
 *      memo on each leg. On an ordinary EVM chain the same shape has to be a
 *      contract, and this is it — deliberately mirroring Tempo's semantics so
 *      the keeper calls the same thing either way and a future move to Tempo is
 *      a config change rather than a rewrite.
 *
 *      Two properties matter and both are load-bearing:
 *
 *      Atomicity. Either every merchant is paid or none is. A partial batch is
 *      the worst outcome: the book says settled, some merchants are not, and
 *      reconciling which is which after the fact is manual work.
 *
 *      Memos. Each leg carries a reference the merchant can match to their own
 *      invoice from a block explorer, without trusting our dashboard. Emitting
 *      it as an indexed event topic is what makes that lookup cheap.
 */
contract BatchSettlement is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable stablecoin;

    /// Bounded so a batch cannot be built that will not fit in a block.
    uint256 public constant MAX_BATCH = 250;

    /// Settlers allowed to draw on this contract's balance. The keeper.
    mapping(address => bool) public isSettler;

    /// Guards against a retried batch paying twice.
    mapping(bytes32 => bool) public batchExecuted;

    uint256 public totalSettled;
    uint256 public batchCount;

    event BatchSettled(
        bytes32 indexed batchId,
        uint256 recipients,
        uint256 totalAmount,
        address indexed settler
    );
    event MerchantPaid(
        bytes32 indexed batchId,
        address indexed merchant,
        uint256 amount,
        bytes32 indexed memo
    );
    event SettlerSet(address indexed settler, bool allowed);
    event Funded(address indexed from, uint256 amount);

    error NotSettler();
    error EmptyBatch();
    error BatchTooLarge(uint256 size);
    error LengthMismatch();
    error BatchAlreadyExecuted(bytes32 batchId);
    error ZeroRecipient(uint256 index);
    error ZeroAmount(uint256 index);
    error InsufficientBalance(uint256 have, uint256 need);

    modifier onlySettler() {
        if (!isSettler[msg.sender]) revert NotSettler();
        _;
    }

    constructor(address initialOwner, IERC20 _stablecoin) Ownable(initialOwner) {
        stablecoin = _stablecoin;
    }

    function setSettler(address settler, bool allowed) external onlyOwner {
        isSettler[settler] = allowed;
        emit SettlerSet(settler, allowed);
    }

    /// @notice Top up the balance this contract pays merchants from.
    function fund(uint256 amount) external {
        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function withdraw(uint256 amount, address to) external onlyOwner {
        stablecoin.safeTransfer(to, amount);
    }

    /**
     * @notice Pay many merchants at once, atomically.
     *
     * @param batchId  Caller-chosen id. A repeat reverts rather than paying
     *                 twice, so a keeper retrying an ambiguous transaction is
     *                 safe.
     * @param memos    One per recipient. A merchant's own invoice reference,
     *                 indexed so they can find their leg without our help.
     *
     * @dev The balance is checked once up front rather than letting a transfer
     *      revert partway. Both revert, but failing early makes the reason
     *      legible: "the pool was short by X" instead of an ERC-20 error from
     *      inside a loop at an index nobody can interpret.
     */
    function settleBatch(
        bytes32 batchId,
        address[] calldata merchants,
        uint256[] calldata amounts,
        bytes32[] calldata memos
    ) external onlySettler nonReentrant returns (uint256 totalAmount) {
        uint256 n = merchants.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n);
        if (amounts.length != n || memos.length != n) revert LengthMismatch();
        if (batchExecuted[batchId]) revert BatchAlreadyExecuted(batchId);

        for (uint256 i = 0; i < n; i++) {
            if (merchants[i] == address(0)) revert ZeroRecipient(i);
            if (amounts[i] == 0) revert ZeroAmount(i);
            totalAmount += amounts[i];
        }

        uint256 balance = stablecoin.balanceOf(address(this));
        if (balance < totalAmount) revert InsufficientBalance(balance, totalAmount);

        batchExecuted[batchId] = true;
        batchCount += 1;
        totalSettled += totalAmount;

        for (uint256 i = 0; i < n; i++) {
            stablecoin.safeTransfer(merchants[i], amounts[i]);
            emit MerchantPaid(batchId, merchants[i], amounts[i], memos[i]);
        }

        emit BatchSettled(batchId, n, totalAmount, msg.sender);
    }

    /// @notice Whether a batch would succeed, without sending it.
    function canSettle(bytes32 batchId, uint256[] calldata amounts)
        external
        view
        returns (bool ok, uint256 required, uint256 available)
    {
        for (uint256 i = 0; i < amounts.length; i++) {
            required += amounts[i];
        }
        available = stablecoin.balanceOf(address(this));
        ok = !batchExecuted[batchId] && available >= required && amounts.length <= MAX_BATCH;
    }
}

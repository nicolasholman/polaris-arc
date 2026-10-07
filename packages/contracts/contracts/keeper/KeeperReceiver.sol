// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title KeeperReceiver
 * @notice What the two Polaris keeper receivers (collections, underwriting)
 *         share: one report entry point that only the Polaris keeper may call.
 *
 * @dev The keeper (services/keeper) is an EOA that pays its gas in USDC on
 *      Arc. A report is `abi.encode(uint8 kind, ...)`; each receiver decodes
 *      its own kind and refuses any other, so a report meant for one receiver
 *      can never run on another.
 *
 *      Why a keeper at all, when collection is permissionless on the loan
 *      engine:
 *        - UnderwritingReceiver: the keeper is the only writer of first-line
 *          credit facts. A forged report would open credit lines, so the key
 *          is kept for this alone.
 *        - CollectionsReceiver: every action it runs is permissionless on its
 *          target, so the keeper can move no money a stranger could not. Its
 *          TaskExecuted and TaskSkipped events are the record of what the
 *          collections run did, which the dashboard and the dunning ladder
 *          read; only the keeper writes that record.
 *
 *      The owner can rotate the keeper (`setKeeper`) and nothing else here.
 *      There is no "accept everyone" setting: the keeper can never be zero.
 */
abstract contract KeeperReceiver is Ownable {
    address public keeper;

    event KeeperSet(address indexed previousKeeper, address indexed keeper);

    error NotKeeper(address sender);
    error ZeroKeeper();
    error UnknownReportKind(uint8 kind);

    constructor(address _keeper) Ownable(msg.sender) {
        _setKeeper(_keeper);
    }

    function setKeeper(address _keeper) external onlyOwner {
        _setKeeper(_keeper);
    }

    /// @notice Run one report. Only the keeper may call it.
    function submitReport(bytes calldata report) external {
        if (msg.sender != keeper) revert NotKeeper(msg.sender);
        _processReport(report);
    }

    function _processReport(bytes calldata report) internal virtual;

    function _requireKind(bytes calldata report, uint8 expected) internal pure {
        uint256 kind = report.length < 32 ? 0 : uint256(bytes32(report[:32]));
        if (kind != expected) revert UnknownReportKind(kind > type(uint8).max ? type(uint8).max : uint8(kind));
    }

    function _setKeeper(address _keeper) private {
        if (_keeper == address(0)) revert ZeroKeeper();
        emit KeeperSet(keeper, _keeper);
        keeper = _keeper;
    }
}

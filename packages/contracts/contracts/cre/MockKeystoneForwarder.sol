// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {IReceiver} from "./IReceiver.sol";

/**
 * @title MockKeystoneForwarder
 * @notice A local stand-in for Chainlink's MockKeystoneForwarder, for the
 *         Hardhat test suite and the local end-to-end run. Never deployed to a
 *         public network: on Monad testnet the receivers point at Chainlink's
 *         own forwarders (plan Appendix A).
 *
 * @dev Written for this repo, not copied. It reproduces what matters of
 *      Chainlink's MockKeystoneForwarder 1.0.0 as documented and probed in
 *      docs/research/cre.md section 7.5:
 *        - `report` takes the same arguments as the production forwarder,
 *          checks no DON signatures, and anyone may call it;
 *        - it splits the raw report the same way: bytes [45, 109) are the
 *          metadata the receiver gets (workflow id, name, owner, report id),
 *          and bytes [109, end) are the body;
 *        - a receiver revert does not revert the transaction; it is reported
 *          as `ReportProcessed(..., result = false)`;
 *        - there is no replay guard.
 *      Like the production KeystoneForwarder it refuses a receiver that does
 *      not declare IReceiver through ERC-165.
 *
 *      Raw report layout (`KeystoneForwarder._getMetadata`):
 *        offset 0   uint8   version
 *        offset 1   bytes32 workflow execution id
 *        offset 33  uint32  timestamp
 *        offset 37  uint32  DON id
 *        offset 41  uint32  DON config version
 *        offset 45  bytes32 workflow id
 *        offset 77  bytes10 workflow name
 *        offset 87  address workflow owner
 *        offset 107 bytes2  report id
 *        offset 109 ...     body
 */
contract MockKeystoneForwarder {
    /// What Chainlink's forwarders answer too ("MockKeystoneForwarder 1.0.0",
    /// "KeystoneForwarder 1.0.0"): lib/lock.js reads it before trusting one.
    function typeAndVersion() external pure virtual returns (string memory) {
        return "MockKeystoneForwarder 1.0.0 (Polaris local)";
    }

    uint256 internal constant METADATA_LENGTH = 109;
    uint256 internal constant FORWARDER_METADATA_LENGTH = 45;

    event ReportProcessed(
        address indexed receiver,
        bytes32 indexed workflowExecutionId,
        bytes2 indexed reportId,
        bool result
    );

    error InvalidReport();

    /// The revert data of the last receiver call that failed, so a test can
    /// assert why without decoding traces. Empty after a success.
    bytes public lastRevertData;

    function report(
        address receiver,
        bytes calldata rawReport,
        bytes calldata, /* reportContext */
        bytes[] calldata /* signatures */
    ) external {
        if (rawReport.length < METADATA_LENGTH) revert InvalidReport();
        bytes32 executionId = bytes32(rawReport[1:33]);
        bytes2 reportId = bytes2(rawReport[107:109]);

        bool ok = route(receiver, rawReport[FORWARDER_METADATA_LENGTH:METADATA_LENGTH], rawReport[METADATA_LENGTH:]);
        emit ReportProcessed(receiver, executionId, reportId, ok);
    }

    /// Deliver `metadata` and `body` to `receiver`. Public and unguarded, as in
    /// Chainlink's mock.
    function route(address receiver, bytes calldata metadata, bytes calldata body) public returns (bool) {
        if (!ERC165Checker.supportsInterface(receiver, type(IReceiver).interfaceId)) {
            lastRevertData = "";
            return false;
        }
        try IReceiver(receiver).onReport(metadata, body) {
            delete lastRevertData;
            return true;
        } catch (bytes memory reason) {
            lastRevertData = reason;
            return false;
        }
    }
}

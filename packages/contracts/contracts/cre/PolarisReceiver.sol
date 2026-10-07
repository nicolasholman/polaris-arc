// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReceiverTemplate} from "./ReceiverTemplate.sol";

/**
 * @title PolarisReceiver
 * @notice What the three Polaris CRE receivers (collections, underwriting,
 *         guardian) add to Chainlink's ReceiverTemplate: the simulation
 *         transmitter guard, and a refusal to run with the forwarder check off.
 *
 * @dev ReceiverTemplate already accepts reports only from the configured
 *      forwarder and, once set, only from the expected workflow owner, name and
 *      id. That is enough behind the production KeystoneForwarder, which checks
 *      the DON's signatures. It is not enough behind Chainlink's
 *      MockKeystoneForwarder, which `cre workflow simulate --broadcast` writes
 *      through: that forwarder is a public contract anyone can call with any
 *      report and any metadata. So while `simulationTransmitter` is set, the
 *      transaction's origin must be it: the key the simulator signs with
 *      (CRE_ETH_PRIVATE_KEY), kept for that alone and never the deployer's,
 *      since any contract that key calls could relay a forged report under
 *      this guard (scripts/deploy-monad.js refuses the deployer on a public
 *      network). Clear it (scripts/lock-receivers.js) when moving to the
 *      production forwarder.
 *
 *      Why all three receivers carry it, and not only the one that writes
 *      credit facts:
 *        - UnderwritingReceiver: a forged report would open credit lines.
 *        - GuardianReceiver: a forged attestation would pause Pay in 4 for
 *          everyone, or report a depegged pool as healthy.
 *        - CollectionsReceiver: every action it runs is permissionless on its
 *          target, so a forged report can move no money a stranger could not.
 *          But its TaskExecuted and TaskSkipped events are the record of what
 *          the collections workflow did, and the indexer's dunning ladder
 *          reads them; only the workflow should write that record. Anyone can
 *          still collect by calling the loan engine directly.
 *
 *      A forwarder check switched off (`setForwarderAddress(0)`, which the
 *      template allows) refuses every report instead of accepting all.
 */
abstract contract PolarisReceiver is ReceiverTemplate {
    /// While non-zero, the only transaction origin allowed to deliver reports.
    address public simulationTransmitter;

    event SimulationTransmitterSet(address indexed transmitter);

    error NotSimulationTransmitter(address origin);
    error ForwarderCheckDisabled();
    /// The report body's first word is not this receiver's kind.
    error UnknownReportKind(uint8 kind);

    constructor(address forwarder, address _simulationTransmitter) ReceiverTemplate(forwarder) {
        simulationTransmitter = _simulationTransmitter;
        emit SimulationTransmitterSet(_simulationTransmitter);
    }

    /// @notice Set, or with zero clear, the simulation-only origin check.
    function setSimulationTransmitter(address transmitter) external onlyOwner {
        simulationTransmitter = transmitter;
        emit SimulationTransmitterSet(transmitter);
    }

    /// Refuse a body whose first word is not `expected`, before decoding the
    /// rest: another workflow's report may not even decode as this one's.
    function _requireKind(bytes calldata report, uint8 expected) internal pure {
        uint256 kind = report.length < 32 ? 0 : uint256(bytes32(report[:32]));
        if (kind != expected) revert UnknownReportKind(kind > type(uint8).max ? type(uint8).max : uint8(kind));
    }

    /// Call first in `_processReport`.
    function _checkDelivery() internal view {
        if (this.getForwarderAddress() == address(0)) revert ForwarderCheckDisabled();
        address transmitter = simulationTransmitter;
        // tx.origin, deliberately: under simulation the forwarder is a public
        // contract anyone can call, so msg.sender says nothing. The simulator's
        // own broadcasting key is the one origin that means "our workflow ran".
        // solhint-disable-next-line avoid-tx-origin
        if (transmitter != address(0) && tx.origin != transmitter) revert NotSimulationTransmitter(tx.origin);
    }
}

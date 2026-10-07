// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockKeystoneForwarder} from "../cre/MockKeystoneForwarder.sol";

/**
 * @title TestKeystoneForwarder
 * @notice The Hardhat suite's stand-in for Chainlink's production
 *         KeystoneForwarder: it answers `typeAndVersion()` as that one does,
 *         so lib/lock.js will move receivers to it on a local chain. It checks
 *         no DON signatures (it is the local mock underneath), so it exists
 *         only on the in-process Hardhat network; no script deploys it.
 */
contract TestKeystoneForwarder is MockKeystoneForwarder {
    function typeAndVersion() external pure override returns (string memory) {
        return "KeystoneForwarder 1.0.0 (Polaris test stand-in, checks no signatures)";
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ICreditGuard
 * @notice What PolarisCheckout asks before it opens a Pay in 4 plan.
 *         GuardianReceiver implements it from the CRE `polaris-guardian`
 *         workflow's latest attestation.
 */
interface ICreditGuard {
    /// @return paused  true when new Pay in 4 plans must be refused now
    /// @return reasons why, as GuardianReceiver's reason bits (0 when open)
    function isCreditPaused() external view returns (bool paused, uint8 reasons);
}

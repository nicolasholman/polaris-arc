// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ICreditGuard
 * @notice What PolarisCheckout asks before it opens a Pay in 4 plan.
 *         CreditGuard implements it from the credit pool's live figures.
 */
interface ICreditGuard {
    function isCreditPaused() external view returns (bool paused, uint8 reasons);
}

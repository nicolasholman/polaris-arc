// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC3009
 * @notice Transfer With Authorization (EIP-3009), as implemented by Circle's
 *         USDC and Agora's AUSD. The owner signs an EIP-712 message off chain
 *         and anyone may submit it, which is what lets a buyer pay without
 *         holding gas.
 * @dev Polaris only ever calls `receiveWithAuthorization`, never
 *      `transferWithAuthorization`, from its contracts. The receive variant
 *      requires `msg.sender == to`, so a signed authorization naming a Polaris
 *      contract as payee cannot be front-run into a plain transfer that skips
 *      the contract's own bookkeeping.
 */
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

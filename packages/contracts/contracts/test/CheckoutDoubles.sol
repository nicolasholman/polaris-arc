// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {MockAUSD} from "../MockAUSD.sol";
import {ScoreManager} from "../ScoreManager.sol";

// Test doubles for the PolarisCheckout and CRE receiver suites. Never deployed
// anywhere but the Hardhat network.

/**
 * @title HookAUSD
 * @notice MockAUSD that, the first time it pays `hookRecipient`, calls
 *         `hookTarget` with `hookData`, the way an ERC-777 style token hands a
 *         recipient control mid-transfer. The suite points it back into
 *         PolarisCheckout to prove a merchant paid from the pool cannot reenter
 *         the checkout.
 */
contract HookAUSD is MockAUSD {
    address public hookRecipient;
    address public hookTarget;
    bytes public hookData;

    bool public hookCalled;
    bool public hookOk;
    bytes public hookReturn;

    function setHook(address recipient, address target, bytes calldata data) external {
        hookRecipient = recipient;
        hookTarget = target;
        hookData = data;
        hookCalled = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == hookRecipient && hookTarget != address(0) && !hookCalled) {
            hookCalled = true;
            (hookOk, hookReturn) = hookTarget.call(hookData);
        }
    }
}

/**
 * @title SmartAccount
 * @notice A minimal ERC-1271 contract account owned by one key, standing in for
 *         a Safe or a passkey smart wallet. It approves by calling the token
 *         itself, since ERC-2612 permits only verify EOA signatures.
 */
contract SmartAccount is IERC1271 {
    address public immutable owner;

    error NotOwner();

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(hash, signature);
        return err == ECDSA.RecoverError.NoError && signer == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        if (msg.sender != owner) revert NotOwner();
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

/**
 * @title GasGuzzler
 * @notice Every call burns all the gas it is given, so a receiver's call into it
 *         fails the way a report with too low a gas limit would. The receivers
 *         must refuse the whole report then, not record a skip.
 */
contract GasGuzzler {
    function _burn() private {
        assembly {
            for {} 1 {} {
                sstore(gas(), 1)
            }
        }
    }

    function collectInstallment(uint256) external returns (uint256) {
        _burn();
        return 0;
    }

    function chargeDue(uint256) external {
        _burn();
    }

    function liquidate(uint256) external {
        _burn();
    }

    function isInstallmentDue(uint256) external pure returns (bool) {
        return true;
    }

    function checkLiquidatable(uint256) external pure returns (bool) {
        return true;
    }

    function isChargeDue(uint256) external pure returns (bool) {
        return true;
    }

    function underwrite(address, ScoreManager.Facts calldata) external returns (uint16) {
        _burn();
        return 0;
    }
}

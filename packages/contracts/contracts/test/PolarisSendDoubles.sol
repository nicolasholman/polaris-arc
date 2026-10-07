// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {MockAUSD} from "../MockAUSD.sol";

// Test doubles for PolarisSend's suite. Never deployed anywhere but the
// Hardhat network: each one reproduces a token or account behaviour that
// MockAUSD cannot, so a guard in PolarisSend has something to refuse.

/**
 * @title FeeOnTransferAUSD
 * @notice MockAUSD that burns 1% of every transfer between two holders, so the
 *         payee receives less than the authorization names. PolarisSend must
 *         refuse to open a link that the escrow cannot fully back.
 */
contract FeeOnTransferAUSD is MockAUSD {
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 fee = value / 100;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}

/**
 * @title ERC1271AUSD
 * @notice An ERC-3009 token that verifies authorizations the way real AUSD
 *         does: through a signature checker that accepts ERC-1271 contract
 *         accounts, with the v, r, s overload packing them as r, s, v. Only
 *         `receiveWithAuthorization` is implemented, because that is all
 *         PolarisSend calls.
 */
contract ERC1271AUSD is ERC20, EIP712 {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorizationSignature();
    error CallerMustBePayee();

    constructor() ERC20("ERC-1271 AUSD", "AUSD") EIP712("ERC-1271 AUSD", "1") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

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
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        if (!SignatureChecker.isValidSignatureNow(from, digest, abi.encodePacked(r, s, v))) {
            revert InvalidAuthorizationSignature();
        }
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}

/**
 * @title OwnedSmartAccount
 * @notice The smallest ERC-1271 account: it accepts a signature over a digest
 *         when its one owner's key produced it. It stands in for a Safe or any
 *         other smart-account sender.
 */
contract OwnedSmartAccount is IERC1271 {
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer,,) = ECDSA.tryRecover(hash, signature);
        return signer == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

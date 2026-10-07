// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IERC3009} from "./interfaces/IERC3009.sol";

/**
 * @title MockAUSD
 * @notice Local and test stand-in for Agora's AUSD. It has 6 decimals,
 *         ERC-2612 permit and ERC-3009 transfer/receive with authorization:
 *         the three things Polaris needs so that no user ever holds gas.
 * @dev A mock dollar, never real money. It runs on a local node and, while
 *      the deployer holds no real testnet AUSD to seed the credit pool with,
 *      on Monad testnet as the demo's clearly labelled stand-in
 *      (`AUSD_MODE=mock`, decision 24): `mint` is open to anyone, so its
 *      balances prove nothing about value. Monad mainnet only ever uses real
 *      AUSD, whose EIP-712 domain must be read from the token at runtime
 *      rather than assumed from this mock. Typehashes match Circle's
 *      FiatToken, which is what AUSD follows.
 *
 *      The EIP-712 domain name and version are real AUSD's, "Agora Dollar" and
 *      "1" (docs/research/ausd.md section 4.2), so client code signs the same
 *      domain here as on Monad, differing only in chainId and
 *      verifyingContract. The ERC-20 name stays "Mock AUSD", so nobody
 *      mistakes this token for the real one. Like AUSD, `name()` is therefore
 *      not the EIP-712 name: read the domain with `eip712Domain()`.
 */
contract MockAUSD is ERC20Permit, IERC3009 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    uint256 public constant FAUCET_AMOUNT = 1_000e6;

    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;
    mapping(address => uint256) public lastFaucetAt;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorizationSignature();
    error CallerMustBePayee();
    error FaucetCooldown();

    constructor() ERC20("Mock AUSD", "AUSD") ERC20Permit("Agora Dollar") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Claim test dollars. Rate-limited so one address cannot drain it.
    function faucet() external {
        if (block.timestamp < lastFaucetAt[msg.sender] + 1 hours) revert FaucetCooldown();
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    // -----------------------------------------------------------------
    // ERC-3009
    // -----------------------------------------------------------------

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

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
    ) external {
        _useAuthorization(
            from,
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            nonce,
            validAfter,
            validBefore,
            v,
            r,
            s
        );
        _transfer(from, to, value);
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
        _useAuthorization(
            from,
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            nonce,
            validAfter,
            validBefore,
            v,
            r,
            s
        );
        _transfer(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed();
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        if (ECDSA.recover(_hashTypedDataV4(structHash), v, r, s) != authorizer) {
            revert InvalidAuthorizationSignature();
        }
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _useAuthorization(
        address from,
        bytes32 structHash,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();
        if (ECDSA.recover(_hashTypedDataV4(structHash), v, r, s) != from) {
            revert InvalidAuthorizationSignature();
        }
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }
}

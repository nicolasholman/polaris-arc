// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/**
 * @title MockUSDC
 * @notice Local and unit-test stand-in for USDC on Arc (and, with another
 *         name, EURC). Never deployed to Arc testnet or mainnet: the deploy
 *         script uses the real token at 0x3600…0000 there.
 * @dev Mirrors the parts of Arc's USDC that Polaris depends on:
 *        - 6 decimals;
 *        - ERC-2612 `permit` and ERC-3009 `transferWithAuthorization` /
 *          `receiveWithAuthorization` / `cancelAuthorization`, with Circle's
 *          typehashes;
 *        - the EIP-712 domain: name = the token's name ("USDC"), version "2",
 *          the chain id and this address, built here rather than with
 *          OpenZeppelin's EIP712 (which would add `eip712Domain()`);
 *        - no ERC-5267 `eip712Domain()`: like FiatToken, the domain is read
 *          from `name()` and `version()`, so the local stack exercises the
 *          same client path as Arc.
 *      `mint` is open to anyone, which is why this contract must never hold
 *      value.
 */
contract MockUSDC is ERC20, Nonces, IERC3009 {
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 public constant FAUCET_AMOUNT = 1_000e6;

    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;
    mapping(address => uint256) public lastFaucetAt;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error PermitExpired();
    error InvalidPermitSignature();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorizationSignature();
    error CallerMustBePayee();
    error FaucetCooldown();

    /// Ten million test dollars to the deployer, as a local stack needs to seed the pool.
    constructor(string memory name_) ERC20(name_, name_) {
        _mint(msg.sender, 10_000_000e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice The EIP-712 domain version, as FiatToken exposes it.
    function version() external pure returns (string memory) {
        return "2";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Claim test dollars. Rate-limited so one address cannot drain a demo.
    function faucet() external {
        if (block.timestamp < lastFaucetAt[msg.sender] + 1 hours) revert FaucetCooldown();
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    // -----------------------------------------------------------------
    // ERC-2612
    // -----------------------------------------------------------------

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (block.timestamp > deadline) revert PermitExpired();
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline));
        if (ECDSA.recover(_hashTypedDataV4(structHash), v, r, s) != owner) revert InvalidPermitSignature();
        _approve(owner, spender, value);
    }

    function nonces(address owner) public view override returns (uint256) {
        return super.nonces(owner);
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name())), keccak256("2"), block.chainid, address(this)));
    }

    function _hashTypedDataV4(bytes32 structHash) private view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(DOMAIN_SEPARATOR(), structHash);
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

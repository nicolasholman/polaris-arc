// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAUSD
 * @notice The subset of Agora's AUSD (v2.1.0, `0xa9012a05…22dC` on Monad
 *         testnet, `0x00000000eFE3…9a012a` on mainnet) that Polaris and its
 *         clients call, with AUSD's custom errors for decoding reverts. Circle's
 *         FiatTokenV2_2 (USDC) has the same functions.
 * @dev From agora-finance/agora-dollar-evm @ ed241d5 (AgoraDollarErc1967Proxy,
 *      Erc2612, AgoraDollar); see docs/research/ausd.md section 9.1. The
 *      EIP-712 domain is name "Agora Dollar", version "1": `name()` returns
 *      "AUSD" and `version()` a struct, so never build the domain from them.
 *      Only `receiveWithAuthorization` requires `msg.sender == to`.
 */
interface IAUSD {
    // ERC-20
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);

    // ERC-3009
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
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
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
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    // ERC-2612
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function nonces(address owner) external view returns (uint256);
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    // ERC-5267
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error InvalidPayee(address caller, address payee);
    error InvalidAuthorization();
    error ExpiredAuthorization();
    error InvalidSignature();
    error UsedOrCanceledAuthorization();
    error Erc2612ExpiredSignature(uint256 deadline);
    error Erc2612InvalidSignature();
    error AccountIsFrozen(address frozenAccount);
    error TransferPaused();
    error SignatureVerificationPaused();
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);
}

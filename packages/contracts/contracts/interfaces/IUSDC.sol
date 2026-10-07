// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IUSDC
 * @notice The subset of USDC on Arc that Polaris and its clients call: the
 *         ERC-20 interface at 0x3600000000000000000000000000000000000000
 *         (6 decimals, the same balance as the 18-decimal native gas token),
 *         with Circle's FiatToken ERC-2612 and ERC-3009 extensions. EURC on
 *         Arc has the same surface.
 * @dev The EIP-712 domain is name "USDC" (EURC: "EURC"), version "2", the
 *      chain id and the token's address. The token does not implement
 *      ERC-5267 `eip712Domain()`, so clients build the domain from `name()`
 *      and `version()` and check it against `DOMAIN_SEPARATOR()`.
 *      Only `receiveWithAuthorization` requires `msg.sender == to`.
 */
interface IUSDC {
    // ERC-20
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function version() external view returns (string memory);
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

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
}

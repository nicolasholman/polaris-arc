// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Stands in for MessageTransmitterV2 on Arc: checks what the real one checks
 * that matters here (the destination caller, a nonce used once) and mints
 * `amount - feeExecuted` to the mint recipient from its own balance. The
 * attestation is not verified (Circle's attesters are the real one's job).
 */
contract MockMessageTransmitterV2 {
    IERC20 public immutable token;
    mapping(bytes32 => bool) public used;

    constructor(IERC20 _token) {
        token = _token;
    }

    function receiveMessage(bytes calldata message, bytes calldata) external returns (bool) {
        bytes32 caller = bytes32(message[108:140]);
        require(caller == bytes32(0) || caller == bytes32(uint256(uint160(msg.sender))), "Invalid caller for message");
        bytes32 nonce = bytes32(message[12:44]);
        require(!used[nonce], "Nonce already used");
        used[nonce] = true;
        address recipient = address(uint160(uint256(bytes32(message[184:216]))));
        uint256 amount = uint256(bytes32(message[216:248]));
        uint256 fee = uint256(bytes32(message[312:344]));
        token.transfer(recipient, amount - fee);
        return true;
    }
}

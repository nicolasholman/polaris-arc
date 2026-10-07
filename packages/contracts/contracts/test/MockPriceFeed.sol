// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A Chainlink-style feed whose answer and update time a test sets. Unit tests only.
contract MockPriceFeed {
    int256 public answer;
    uint256 public updatedAt;
    bool public broken;
    uint8 public constant decimals = 8;

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

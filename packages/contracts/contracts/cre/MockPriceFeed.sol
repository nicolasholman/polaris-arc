// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/**
 * @title MockPriceFeed
 * @notice A local stand-in for Chainlink's AUSD/USD feed on Monad mainnet
 *         (0xE20751C7B5867bCBef815ffc1b284c3f412a9e13, 8 decimals), for the
 *         Hardhat suite, the local end-to-end run and the CRE workflows' local
 *         chain. Never deployed to a public network: there the guardian reads
 *         the real feed on Monad mainnet.
 * @dev Anyone may post a round. It keeps every round so `getRoundData` works
 *      like a real aggregator's.
 */
contract MockPriceFeed is AggregatorV3Interface {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public immutable decimals;
    string public description;
    uint80 public latestRound;
    mapping(uint80 => Round) private _rounds;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    error RoundNotFound(uint80 roundId);

    constructor(uint8 _decimals, string memory _description, int256 initialAnswer) {
        decimals = _decimals;
        description = _description;
        _post(initialAnswer, block.timestamp);
    }

    function version() external pure returns (uint256) {
        return 4;
    }

    /// @notice Post a new round, dated now.
    function setAnswer(int256 answer) external {
        _post(answer, block.timestamp);
    }

    /// @notice Post a new round with an explicit updatedAt (to make one stale).
    function setRound(int256 answer, uint256 updatedAt) external {
        _post(answer, updatedAt);
    }

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (roundId == 0 || roundId > latestRound) revert RoundNotFound(roundId);
        Round memory r = _rounds[roundId];
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        roundId = latestRound;
        Round memory r = _rounds[roundId];
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    function _post(int256 answer, uint256 updatedAt) private {
        uint80 round = latestRound + 1;
        latestRound = round;
        _rounds[round] = Round(answer, updatedAt);
        emit AnswerUpdated(answer, round, updatedAt);
    }
}

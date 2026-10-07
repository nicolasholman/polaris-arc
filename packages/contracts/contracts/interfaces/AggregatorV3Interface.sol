// SPDX-License-Identifier: MIT
// Chainlink's AggregatorV3Interface (MIT), as published in
// smartcontractkit/chainlink, contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol.
// The CRE guardian reads the AUSD/USD feed through it, and GuardianReceiver
// implements it so other apps can read Polaris pool health like a feed.
pragma solidity ^0.8.0;

// solhint-disable-next-line interface-starts-with-i
interface AggregatorV3Interface {
  function decimals() external view returns (uint8);

  function description() external view returns (string memory);

  function version() external view returns (uint256);

  function getRoundData(
    uint80 _roundId
  ) external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

  function latestRoundData()
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

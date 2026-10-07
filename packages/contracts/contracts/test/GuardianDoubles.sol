// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPolarisPool} from "../cre/GuardianReceiver.sol";

// Test doubles for the GuardianReceiver suite. Never deployed anywhere but the
// Hardhat network.

/**
 * @title PoolDouble
 * @notice A credit pool whose `poolState()` the test sets directly, so the
 *         guardian's live pool checks (low cash, bad debt, the originations
 *         floor, acknowledged bad debt) can be driven to any figure without
 *         running loans to default. The real PolarisLoanEngine is what the
 *         rest of the suite uses.
 */
contract PoolDouble is IPolarisPool {
    address public immutable stablecoin;
    PoolState private _state;

    constructor(address _stablecoin) {
        stablecoin = _stablecoin;
    }

    function setState(uint256 freeCash, uint256 totalOwed, uint256 badDebt, uint256 totalOriginated) external {
        _state = PoolState({freeCash: freeCash, totalOwed: totalOwed, badDebt: badDebt, totalOriginated: totalOriginated});
    }

    function poolState() external view returns (PoolState memory) {
        return _state;
    }
}

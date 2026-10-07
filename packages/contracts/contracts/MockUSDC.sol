// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Six-decimal test stablecoin for Base Sepolia, with an open faucet so
 *         a demo borrower can fund themselves without a deployer round trip.
 */
contract MockUSDC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;

    mapping(address => uint256) public lastFaucetAt;

    error FaucetCooldown();

    constructor() ERC20("Polaris USD", "pUSDC") {
        _mint(msg.sender, 10_000_000e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Claim test USDC. Rate-limited so one address cannot drain it.
    function faucet() external {
        if (block.timestamp < lastFaucetAt[msg.sender] + 1 hours) revert FaucetCooldown();
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Stands in for both halves of CCTP V2 in a one-chain Chainlink Local test:
 * `depositForBurn` takes the tokens (the burn on the source chain) and, unless
 * deferred, hands them to the mint recipient at once (the mint on Arc).
 * Deferred, the mints wait for `releaseAll`, so a test can deliver the CCIP
 * message before the dollars, as happens when CCTP waits for finality.
 */
contract MockTokenMessengerV2 {
    struct Mint {
        address to;
        uint256 amount;
    }

    IERC20 public immutable token;
    bool public deferred;
    Mint[] public pending;
    uint32 public lastDestinationDomain;
    uint32 public lastMinFinality;
    uint256 public lastMaxFee;
    bytes32 public lastDestinationCaller;

    constructor(IERC20 _token) {
        token = _token;
    }

    function setDeferred(bool d) external {
        deferred = d;
    }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        require(burnToken == address(token), "wrong token");
        token.transferFrom(msg.sender, address(this), amount);
        lastDestinationDomain = destinationDomain;
        lastMinFinality = minFinalityThreshold;
        lastMaxFee = maxFee;
        lastDestinationCaller = destinationCaller;
        address to = address(uint160(uint256(mintRecipient)));
        if (deferred) pending.push(Mint(to, amount));
        else token.transfer(to, amount);
    }

    function releaseAll() external {
        for (uint256 i; i < pending.length; ++i) token.transfer(pending[i].to, pending[i].amount);
        delete pending;
    }
}

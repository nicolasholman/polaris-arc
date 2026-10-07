// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CreditGuard, IPolarisPool, IPriceFeed} from "../../contracts/CreditGuard.sol";
import {PoolDouble} from "../../contracts/test/PoolDouble.sol";

/**
 * CreditGuard's peg check against Chainlink's real USDC / USD Data Feed on a
 * fork of Arc mainnet (read only: nothing is sent to mainnet). Run with
 * ARC_FORK_TESTS=1.
 */
contract ArcMainnetFeedsTest is Test {
    address constant USDC_USD = 0x84EA90AC252Dc437031461836DB5164219147905;
    address constant EURC_USD = 0x361b95c10b76Ca3f35C686d423e43A951755Bf23;
    address constant EUR_USD = 0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D;

    function setUp() public {
        if (!vm.envOr("ARC_FORK_TESTS", false)) vm.skip(true);
        vm.createSelectFork("arc_mainnet");
    }

    function test_TheGuardReadsTheRealUsdcPegOnArc() public {
        PoolDouble pool = new PoolDouble(0x3600000000000000000000000000000000000000);
        pool.setState(5_000e6, 0, 0, 0);
        CreditGuard guard = new CreditGuard(address(this), IPolarisPool(address(pool)), CreditGuard.Thresholds({minFreeCash: 1_000e6, maxBadDebtBps: 500, minOriginated: 10_000e6}));
        guard.setPriceCheck(IPriceFeed(USDC_USD), 98_000_000, 26 hours);
        (uint8 reasons, int256 price, uint256 updatedAt) = guard.priceReasons();
        assertEq(reasons, 0, "USDC holds its peg on Arc");
        assertGt(price, 98_000_000);
        assertLt(price, 102_000_000);
        assertGt(updatedAt, block.timestamp - 26 hours);
        (bool paused,) = guard.isCreditPaused();
        assertFalse(paused);
        // A floor above today's price reads as a depeg: the check is live, not a constant.
        guard.setPriceCheck(IPriceFeed(USDC_USD), price + 1, 26 hours);
        (reasons,,) = guard.priceReasons();
        assertEq(reasons, guard.REASON_DEPEG());
    }

    function test_EurcAndEurFeedsAgree() public view {
        (, int256 eurc,, uint256 a,) = IPriceFeed(EURC_USD).latestRoundData();
        (, int256 eur,, uint256 b,) = IPriceFeed(EUR_USD).latestRoundData();
        assertGt(eurc, 0);
        assertGt(eur, 0);
        assertGt(a, block.timestamp - 26 hours);
        assertGt(b, block.timestamp - 26 hours);
        // EURC tracks the euro within 2%.
        int256 diff = eurc > eur ? eurc - eur : eur - eurc;
        assertLt(diff * 100, eur * 2);
    }
}

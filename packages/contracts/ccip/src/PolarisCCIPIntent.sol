// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title PolarisCCIPIntent
 * @notice The instruction a Polaris CCIP message carries from another chain to
 *         Arc, while Circle's CCTP V2 moves the dollars. USDC is not a CCIP
 *         token on Arc, so the two travel separately: the sender burns USDC
 *         with CCTP to PolarisCCIPReceiver on Arc, and sends this intent with
 *         CCIP; the receiver acts once both have arrived.
 *
 *   abi.encode(uint8 kind, bytes body)
 *     kind 1 PAY:   abi.encode(PayIntent)    pay a Polaris order on Arc
 *     kind 2 REPAY: abi.encode(RepayIntent)  credit a Pay in 4 borrower and collect their due instalment
 */
library PolarisCCIPIntent {
    uint8 internal constant KIND_PAY = 1;
    uint8 internal constant KIND_REPAY = 2;

    /// Most one intent may move: $10,000 (USDC, 6 decimals).
    uint256 internal constant MAX_AMOUNT = 10_000e6;

    struct PayIntent {
        /// Who paid on the source chain.
        address sourcePayer;
        /// Where the dollars go back on Arc if the order can't be paid (already paid, wrong price).
        address arcRefundTo;
        /// The merchant and order, exactly as a Polaris checkout session names them.
        address merchant;
        string orderId;
        /// USDC base units burned with CCTP for this intent.
        uint256 amount;
    }

    struct RepayIntent {
        address sourcePayer;
        /// The Pay in 4 borrower on Arc: the dollars become theirs.
        address borrower;
        uint256 loanId;
        uint256 amount;
    }
}

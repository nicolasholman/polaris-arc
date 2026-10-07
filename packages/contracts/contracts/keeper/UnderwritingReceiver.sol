// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KeeperReceiver} from "./KeeperReceiver.sol";
import {ScoreManager} from "../ScoreManager.sol";

/**
 * @title UnderwritingReceiver
 * @notice Receives the Polaris keeper's underwriting report and opens each
 *         buyer's first credit line with `ScoreManager.underwrite(user, facts)`.
 *
 * @dev The keeper (services/keeper) runs a review when a buyer asks for Pay
 *      in 4 and signs their consent. It reads facts about the buyer's Arc
 *      account and any history wallet they linked and proved they own (public
 *      RPCs on Arc and other chains, and Etherscan, Nansen or Zerion when
 *      their keys are set), and the report carries those facts, never a
 *      score. ScoreManager computes the score on chain, caps the opening line
 *      at $1,000, refuses evidence older than 15 minutes and refuses a second
 *      underwriting of any wallet. The keeper key is therefore the only extra
 *      trust this receiver adds, and every guard below narrows that.
 *
 *      Report:
 *        abi.encode(uint8 kind, Underwriting[] items)   kind == REPORT_KIND (2)
 *        Underwriting = (address user, address linkedWallet, ScoreManager.Facts facts)
 *        Facts = (uint32 walletAgeDays, uint32 txCount, uint64 stableBalance,
 *                 uint32 defiTenureDays, uint16 priorLiquidations,
 *                 uint16 relatedWallets, bool exchangeFunded, uint64 observedAt)
 *      A batch, so the keeper can drain its queue in one transaction.
 *      `linkedWallet` is the history wallet the buyer proved they own, or zero
 *      for an account scored alone.
 *
 *      Guard, beyond the keeper check: one history backs one credit line,
 *      ever. A linked wallet backs one Polaris account; otherwise a single old
 *      wallet could open a line for every fresh passkey account its owner
 *      creates. Recorded only when underwriting succeeds, so a refused report
 *      links nothing. For the same reason a wallet already backing an account
 *      can't be underwritten as an account itself (`UserIsLinkedHistory`), and
 *      a wallet already underwritten as an account can't be linked as
 *      another's history (`WalletAlreadyUnderwritten`).
 *
 *      Each item runs in its own try/catch, emitting `UnderwritingApplied` or
 *      `UnderwritingRefused` with ScoreManager's revert data (`StaleEvidence`,
 *      `AlreadyHasRecord`, `ThinFile`), which the app and API read back. As in
 *      CollectionsReceiver, running out of gas reverts the whole report.
 */
contract UnderwritingReceiver is KeeperReceiver {
    uint8 public constant REPORT_KIND = 2;

    struct Underwriting {
        address user;
        address linkedWallet;
        ScoreManager.Facts facts;
    }

    ScoreManager public immutable scoreManager;

    /// The Polaris account each history wallet has backed.
    mapping(address => address) public linkedUserOf;

    event UnderwritingApplied(address indexed user, address indexed linkedWallet, uint16 score);
    event UnderwritingRefused(address indexed user, address indexed linkedWallet, bytes reason);

    error InsufficientGasForItem(uint256 index);
    error ZeroAddress();
    /// Per-item refusals, delivered as `UnderwritingRefused.reason`.
    error InvalidUser(address user);
    error WalletAlreadyLinked(address wallet, address user);
    /// `user` already backs `account` as its linked history.
    error UserIsLinkedHistory(address user, address account);
    /// `wallet` already holds an underwritten line of its own.
    error WalletAlreadyUnderwritten(address wallet);

    constructor(address _keeper, ScoreManager _scoreManager) KeeperReceiver(_keeper) {
        if (address(_scoreManager) == address(0)) revert ZeroAddress();
        scoreManager = _scoreManager;
    }

    function _processReport(bytes calldata report) internal override {

        _requireKind(report, REPORT_KIND);
        (, Underwriting[] memory items) = abi.decode(report, (uint8, Underwriting[]));

        for (uint256 i; i < items.length; ++i) {
            _underwrite(i, items[i]);
        }
    }

    function _underwrite(uint256 index, Underwriting memory item) private {
        address user = item.user;
        address wallet = item.linkedWallet;
        if (user == address(0)) {
            emit UnderwritingRefused(user, wallet, abi.encodeWithSelector(InvalidUser.selector, user));
            return;
        }
        // A wallet that already backs an account has lent it its history; a
        // line of its own would be a second line on the same history. (Only
        // another account can be recorded here: a self-link records nothing.)
        address backs = linkedUserOf[user];
        if (backs != address(0)) {
            emit UnderwritingRefused(
                user,
                wallet,
                abi.encodeWithSelector(UserIsLinkedHistory.selector, user, backs)
            );
            return;
        }
        // A wallet linked to itself, or none, is the account scored alone.
        bool links = wallet != address(0) && wallet != user;
        if (links) {
            address holder = linkedUserOf[wallet];
            if (holder != address(0) && holder != user) {
                emit UnderwritingRefused(
                    user,
                    wallet,
                    abi.encodeWithSelector(WalletAlreadyLinked.selector, wallet, holder)
                );
                return;
            }
            // The converse: a wallet whose history already opened its own
            // line can't lend that history to another account.
            if (scoreManager.profileOf(wallet).underwritten) {
                emit UnderwritingRefused(
                    user,
                    wallet,
                    abi.encodeWithSelector(WalletAlreadyUnderwritten.selector, wallet)
                );
                return;
            }
        }

        uint256 gasBefore = gasleft();
        try scoreManager.underwrite(user, item.facts) returns (uint16 score) {
            if (links) linkedUserOf[wallet] = user;
            emit UnderwritingApplied(user, wallet, score);
        } catch (bytes memory reason) {
            if (gasleft() <= gasBefore / 63) revert InsufficientGasForItem(index);
            emit UnderwritingRefused(user, wallet, reason);
        }
    }
}

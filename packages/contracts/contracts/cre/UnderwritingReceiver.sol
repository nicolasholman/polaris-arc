// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PolarisReceiver} from "./PolarisReceiver.sol";
import {ScoreManager} from "../ScoreManager.sol";

/**
 * @title UnderwritingReceiver
 * @notice Receives the Chainlink CRE `polaris-underwrite` workflow's signed
 *         report and opens each buyer's first credit line with
 *         `ScoreManager.underwrite(user, facts)`.
 *
 * @dev The workflow is fired over HTTP when a buyer asks for Pay in 4. Every
 *      node of the DON fetches facts about the buyer's account and any history
 *      wallet they linked (Nansen, Zerion, RPC), the DON agrees on them, and
 *      the report carries those facts, never a score. ScoreManager computes
 *      the score on chain, caps the opening line at $1,000, refuses evidence
 *      older than 15 minutes and refuses a second underwriting of any wallet.
 *      This receiver's owner is therefore the only extra trust it adds, and
 *      every guard below narrows that.
 *
 *      Report body (after the forwarder strips the 109-byte header):
 *        abi.encode(uint8 kind, Underwriting[] items)   kind == REPORT_KIND (2)
 *        Underwriting = (address user, address linkedWallet, ScoreManager.Facts facts)
 *        Facts = (uint32 walletAgeDays, uint32 txCount, uint64 stableBalance,
 *                 uint32 defiTenureDays, uint16 priorLiquidations,
 *                 uint16 relatedWallets, bool exchangeFunded, uint64 observedAt)
 *      A batch, because the HTTP trigger fires at most once per 30 seconds and
 *      the API queues requests between firings. `linkedWallet` is the history
 *      wallet the buyer proved they own, or zero for an account scored alone.
 *
 *      Guards, beyond ReceiverTemplate's forwarder, owner and name checks:
 *        - One history backs one credit line, ever. A linked wallet backs one
 *          Polaris account; otherwise a single old wallet could open a line
 *          for every fresh Face ID account its owner creates. Recorded only
 *          when underwriting succeeds, so a refused report links nothing. For
 *          the same reason a wallet already backing an account can't be
 *          underwritten as an account itself (`UserIsLinkedHistory`), and a
 *          wallet already underwritten as an account can't be linked as
 *          another's history (`WalletAlreadyUnderwritten`): either way one
 *          history would open two lines.
 *        - While the forwarder is Chainlink's MockKeystoneForwarder
 *          (simulation), anyone can call it with any report, which here would
 *          let anyone write credit facts. So `simulationTransmitter`, while
 *          set, must be the transaction's origin, and a forwarder check
 *          switched off refuses every report (PolarisReceiver).
 *
 *      Each item runs in its own try/catch, emitting `UnderwritingApplied` or
 *      `UnderwritingRefused` with ScoreManager's revert data (`StaleEvidence`,
 *      `AlreadyHasRecord`), because a simulated `onReport` revert reads as
 *      success and these events are what the app and API watch. As in
 *      CollectionsReceiver, running out of gas reverts the whole report.
 */
contract UnderwritingReceiver is PolarisReceiver {
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

    constructor(address forwarder, ScoreManager _scoreManager, address _simulationTransmitter)
        PolarisReceiver(forwarder, _simulationTransmitter)
    {
        if (address(_scoreManager) == address(0)) revert ZeroAddress();
        scoreManager = _scoreManager;
    }

    function _processReport(bytes calldata report) internal override {
        _checkDelivery();

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

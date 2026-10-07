import "server-only";

import { encodeFunctionData, keccak256, parseAbi, stringToHex, toHex, type Address, type Hex } from "viem";

/**
 * Circle's contracts on Arc that Polaris calls directly, by hand-written ABI
 * (they are not ours, so they are not in @polarispay/contracts/abi):
 *
 * - Memo (0x5294…e505 on testnet and mainnet): `memo(target, data, memoId,
 *   memoData)` runs `target.call(data)` with the original EOA kept as
 *   msg.sender (Arc's CallFrom precompile) and emits `Memo(sender, target,
 *   callDataHash, memoId, memo, memoIndex)`. The relayer wraps every checkout
 *   in one, so each payment carries the merchant's order reference on chain.
 * - CCTP V2's MessageTransmitterV2 on Arc (domain 26): `receiveMessage
 *   (message, attestation)` mints USDC burned on another chain to its
 *   recipient. Anyone may call it when the burn named no destination caller,
 *   so the relayer finishes a buyer's cross-chain top-up and pays the gas.
 */

export const memoAbi = parseAbi([
  "function memo(address target, bytes data, bytes32 memoId, bytes memoData)",
  "event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)",
  "event BeforeMemo(uint256 indexed memoIndex)",
]);

export const messageTransmitterV2Abi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
  "event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)",
]);

export const tokenMessengerV2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)",
]);

/** A memo the relayer attaches to a call: an id to look it up by, and the bytes it carries. */
export type CallMemo = { id: Hex; text: string };

/** The memo for a checkout payment: its id is the order key (keccak256(merchant, orderId)), its text names the order. */
export function orderMemo(orderKey: Hex, kind: "pay" | "plan" | "subscribe" | "payout", reference: string): CallMemo {
  return { id: orderKey, text: `polaris:${kind}:${reference}`.slice(0, 200) };
}

/** A memo id for something without an order key (a payout, a top-up): keccak256 of its reference. */
export function memoIdOf(reference: string): Hex {
  return keccak256(stringToHex(reference));
}

/** `Memo.memo(target, data, memo.id, utf8(memo.text))`. */
export function wrapInMemo(target: Address, data: Hex, memo: CallMemo): Hex {
  return encodeFunctionData({ abi: memoAbi, functionName: "memo", args: [target, data, memo.id, toHex(memo.text)] });
}

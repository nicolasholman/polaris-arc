import { type Address, encodeAbiParameters, encodePacked, type Hex, keccak256 } from "viem";

/**
 * Nonces the contracts derive instead of taking from the caller. Because the
 * buyer's ERC-3009 signature commits to them, a relayer can't point the money
 * anywhere else: change the merchant, the order or the link key and the token
 * rejects the signature.
 */

/**
 * PolarisPayments: `keccak256(abi.encodePacked(merchant, orderId))`, which is
 * also the payment id. `orderId` is the merchant's order reference, a Solidity
 * `string` (see `payWithAuthorization(address,address,uint256,string,...)`).
 */
export function paymentNonce(merchant: Address, orderId: string): Hex {
  return keccak256(encodePacked(["address", "string"], [merchant, orderId]));
}

/**
 * PolarisSplit: `keccak256(abi.encode(splitId, index))`. A friend's share
 * authorisation commits to this split and this share: pointed at another,
 * the token rejects it.
 */
export function shareNonce(splitId: Hex, index: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [splitId, index]));
}

/** PolarisSplit.splitIdOf: `keccak256(abi.encode(organiser, salt))`, known before the split lands. */
export function splitIdOf(organiser: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [organiser, salt]));
}

/**
 * PolarisSend: `keccak256(abi.encode(linkKey, expiresAt))`. `expiresAt` is a
 * `uint64` in seconds; `abi.encode` pads it to a word, as it does a uint256.
 */
export function sendNonce(linkKey: Address, expiresAt: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [linkKey, expiresAt]));
}

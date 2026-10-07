import { parseAbi } from "viem";

/**
 * The view functions the app reads from the chain directly (everything else
 * comes from Polaris for Business). Each matches the contract's exported ABI
 * in packages/contracts/abi (test/reads.test.ts checks).
 */

/** The dollar: the account's balance. */
export const ausdAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

/** PolarisSend: a send link's state. */
export const sendAbi = parseAbi([
  "function linkOf(address linkKey) view returns ((address sender, uint128 amount, uint64 expiresAt))",
  "function keyUsed(address linkKey) view returns (bool)",
]);

/**
 * CollateralVault: the dollars an account has locked in Boost, what each
 * dollar adds to the limit, what it can take out now (all of it, or nothing
 * while a Pay in 4 plan is open), and the nonce its next Withdraw signs. The
 * vault's EIP-712 domain is read with ERC-5267 (`sign/domain.ts`).
 */
export const vaultAbi = parseAbi([
  "function lockedOf(address user) view returns (uint256)",
  "function creditMultiplierBps() view returns (uint256)",
  "function withdrawable(address user) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
]);

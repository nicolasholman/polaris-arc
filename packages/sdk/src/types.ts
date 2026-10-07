/** A 0x-prefixed 20-byte address. */
export type Address = `0x${string}`;
/** A 0x-prefixed hex string. */
export type Hex = `0x${string}`;

/** The Polaris contracts a chain preset knows about. */
export type ContractName =
  | "payments"
  | "loanEngine"
  | "scoreManager"
  | "collateralVault"
  | "checkout"
  | "send"
  | "merchantRegistry"
  | "collector"
  | "batchSettlement";

/** How the buyer pays in the hosted checkout. */
export type CheckoutMode = "now" | "later" | "subscribe";

export const CHECKOUT_MODES: readonly CheckoutMode[] = ["now", "later", "subscribe"];

/**
 * Anything EIP-1193: MetaMask's `window.ethereum`, a Privy or WalletConnect
 * provider, a Mera account wrapped by viem, or Hardhat's `network.provider`.
 */
export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

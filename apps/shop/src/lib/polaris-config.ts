/** A local chain's name, RPC and Polaris contracts (from its deployment record). */
export type LocalChain = {
  chainId: number;
  name: string;
  rpcUrl: string;
  /** "" when there is no explorer (a Hardhat node). */
  explorer: string;
  stablecoin: `0x${string}`;
  payments: `0x${string}`;
  loanEngine: `0x${string}`;
  scoreManager: `0x${string}`;
  collateralVault: `0x${string}`;
  checkout: `0x${string}`;
  send: `0x${string}`;
  merchantRegistry: `0x${string}`;
  collector: `0x${string}`;
  batchSettlement: `0x${string}`;
};

/**
 * Polaris's risk guard, as the store shows it: while `paused`, Pay in 4 is
 * offered nowhere and `message` says so ("Pay in 4 is paused by our risk
 * guard; pay now works as usual."); Pay now and Subscribe carry on.
 */
export type ShopCreditGuard = {
  paused: boolean;
  message: string | null;
  /** open, paused, stale, never, unconfigured, unavailable (polarispay-sdk's CreditGuardStatus). */
  state: string;
};

/** The sentence while paused, from the guard when it sent one. */
export function pausedMessage(guard: ShopCreditGuard | null | undefined): string | null {
  return guard?.paused ? (guard.message ?? "Pay in 4 is paused by our risk guard; pay now works as usual.") : null;
}

/**
 * The Polaris settings a browser may see, handed from server components to
 * client ones. No secrets: the publishable key is public by design.
 */
export type BrowserPolarisConfig =
  | {
      ok: true;
      publishableKey: string;
      /** The Polaris app, whose /pay/[id] sheet is the hosted checkout. */
      checkoutOrigin: string;
      relayUrl: string;
      payInFourAprBps: number;
      /**
       * `pnpm demo:local`'s chain (development only): the contracts a direct
       * wallet payment signs for. Null: Monad testnet, from polarispay-sdk.
       */
      chain?: LocalChain | null;
      /** Polaris's risk guard when the page was served (`creditGuard()`): while paused, Pay in 4 is off. Null: couldn't be read (treated as open). */
      creditGuard?: ShopCreditGuard | null;
    }
  | { ok: false; reason: string; payInFourAprBps: number };

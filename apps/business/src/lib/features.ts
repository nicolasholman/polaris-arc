import type { Capabilities } from "./data/types";

/**
 * What can actually work right now, decided from what the server says it is
 * connected to (GET /api/health: the chain, the relayer, the payout signer).
 * A control whose service isn't connected is disabled with the reason beside
 * it: nothing is left to fail, and nothing claims money moved when it didn't.
 */

/** Our payout signer's key quorum, added to a merchant's wallet for automatic payouts. */
export const PAYOUT_SIGNER_ID = process.env.NEXT_PUBLIC_PRIVY_PAYOUT_SIGNER_ID || "";

/**
 * The demo storefront (apps/shop, "Halcyon"), which pays through
 * polarispay-sdk. Set NEXT_PUBLIC_DEMO_SHOP_URL wherever it's deployed.
 * Development falls back to the local shop (`pnpm dev:demo` runs both), and
 * components read it through useDemoShopUrl(), which checks the shop answers
 * first. A production build without it shows the demo shop's buttons
 * disabled ("coming soon") rather than sending visitors to their own localhost.
 */
export const DEMO_SHOP_URL: string | null =
  process.env.NEXT_PUBLIC_DEMO_SHOP_URL || (process.env.NODE_ENV === "development" ? "http://127.0.0.1:3600" : null);

/** What the demo shop's controls say while there's no shop to open. */
export const DEMO_SHOP_SOON = "Demo shop coming soon";

export type Readiness = {
  /** Null when one-tap withdraw works; otherwise why it doesn't, in words. */
  withdraw: string | null;
  /** Null when automatic payouts can be switched on. */
  autoPayouts: string | null;
  /** Null when buyers can open this merchant's links. */
  links: string | null;
  /** Null when the business can be registered on Monad. */
  registration: string | null;
};

const CHECKING = "Checking what this server is connected to…";
const UNCHECKED = "We couldn't check this server's connections. We'll try again in a moment.";

/**
 * Readiness for the dashboard's money controls: a control whose service
 * isn't connected (no chain, no relayer, no payout signer) refuses, with the
 * reason.
 */
export function readiness(caps: Capabilities | null | undefined, failed = false): Readiness {
  if (!caps) {
    const why = failed ? UNCHECKED : CHECKING;
    return { withdraw: why, autoPayouts: why, links: why, registration: why };
  }

  const noChain = caps.chain
    ? null
    : "This server isn't connected to Monad yet, so nothing can move.";
  const noRelayer = caps.relayer ? null : "Polaris's relayer isn't running on this server yet. It pays the network fee, so nothing can be sent until it is.";
  const noSigner =
    caps.automaticPayouts && PAYOUT_SIGNER_ID ? null : "Automatic payouts switch on once the Privy payout signer is set up on this server.";

  const noCheckout = caps.checkoutOrigin ? null : "Links go live once the checkout origin is configured on this server.";
  const noPublicUrl = caps.registrationUrl ? null : "Registration on Monad opens once this server's public URL is configured.";

  return {
    withdraw: noChain ?? noRelayer,
    autoPayouts: noChain ?? noRelayer ?? noSigner,
    links: noChain ? "Buyers can open links once this server is connected to Monad." : (noRelayer ?? noCheckout),
    registration: noChain ? "Registration on Monad opens once this server is connected to it." : (noRelayer ?? noPublicUrl),
  };
}

"use client";

import React, { createContext, useContext, useMemo, type ReactNode } from "react";

import type { PolarisChain, PolarisContracts } from "../chains.js";
import { createPolaris, type Polaris, type PolarisOptions } from "../client.js";

/**
 * One Polaris client for a subtree. Components take `polaris` or
 * `publishableKey` props directly too; the provider saves repeating them.
 *
 *   <PolarisProvider publishableKey="pk_test_…">
 *     <PolarisMessaging amount="200.00" />
 *     <PolarisCheckoutButton createSession={…} />
 *   </PolarisProvider>
 */

const PolarisContext = createContext<Polaris | null>(null);

export type PolarisProviderProps = PolarisOptions & {
  /** An existing client, instead of options. */
  polaris?: Polaris;
  children?: ReactNode;
};

export function PolarisProvider({ polaris, children, ...options }: PolarisProviderProps) {
  const client = usePolarisClient({ polaris, ...options });
  return <PolarisContext.Provider value={client}>{children}</PolarisContext.Provider>;
}

/** The client from the nearest PolarisProvider, or null. */
export function usePolaris(): Polaris | null {
  return useContext(PolarisContext);
}

/** Props every connected component accepts. */
export type PolarisClientProps = {
  /** An existing client. */
  polaris?: Polaris;
  publishableKey?: string;
  checkoutOrigin?: string;
  chain?: PolarisChain | PolarisContracts;
  relayUrl?: string;
  provider?: unknown;
};

/**
 * Resolve a client: an explicit `polaris`, else one built from the props,
 * else the provider's, else a default client. Memoised on the options that
 * matter, so re-renders don't rebuild it.
 */
export function usePolarisClient(props: PolarisClientProps & PolarisOptions): Polaris {
  const fromContext = useContext(PolarisContext);
  const { polaris, publishableKey, checkoutOrigin, chain, contracts, relayUrl, provider, rpcUrl, apiKey, endpoint, fetch } = props;
  const hasOwnOptions = publishableKey !== undefined || checkoutOrigin !== undefined || chain !== undefined || contracts !== undefined || relayUrl !== undefined || provider !== undefined;
  return useMemo(() => {
    if (polaris) return polaris;
    if (!hasOwnOptions && fromContext) return fromContext;
    return createPolaris({ publishableKey, checkoutOrigin, chain, contracts, relayUrl, provider, rpcUrl, apiKey, endpoint, fetch });
  }, [polaris, hasOwnOptions, fromContext, publishableKey, checkoutOrigin, chain, contracts, relayUrl, provider, rpcUrl, apiKey, endpoint, fetch]);
}

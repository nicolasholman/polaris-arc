"use client";

import { createContext, useContext } from "react";

import type { Capabilities, Merchant } from "./data/types";

type MerchantContextValue = {
  merchant: Merchant;
  /** Load /api/me again (after naming the business, or once the wallet exists). */
  refresh: () => void;
  /** What this server is connected to; null while it loads or if it can't be read. */
  capabilities: Capabilities | null;
  /** Why the capabilities couldn't be read (they are retried); null otherwise. */
  capabilitiesError?: string | null;
  /** Read the capabilities again now. */
  retryCapabilities?: () => void;
};

export const MerchantContext = createContext<MerchantContextValue | null>(null);

/** The signed-in merchant. Only available inside the dashboard frame. */
export function useMerchant(): MerchantContextValue {
  const ctx = useContext(MerchantContext);
  if (!ctx) throw new Error("useMerchant must be used inside the dashboard layout");
  return ctx;
}

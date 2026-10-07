"use client";

// Every browser-side Polaris call the shop makes goes through this file.
import { ARC_TESTNET, createPolaris, type Polaris, type PolarisChain } from "polarispay-sdk";

import type { BrowserPolarisConfig } from "./polaris-config";

export { PolarisCheckoutButton, PolarisMark, PolarisMessaging } from "polarispay-sdk/react";
export { ARC_TESTNET, isPolarisError, quotePayIn4 } from "polarispay-sdk";
export type { CheckoutMode, CheckoutResult, PayResult, PayStage, Polaris, PolarisError } from "polarispay-sdk";

/** The chain direct wallet payments sign for: `pnpm demo:local`'s, or Arc testnet. */
export function chainFor(config: BrowserPolarisConfig): PolarisChain {
  if (config.ok && config.chain) {
    return {
      ...ARC_TESTNET,
      ...config.chain,
      key: "local",
      testnet: true,
      deployment: { source: "pnpm demo:local", deployedAt: null },
    };
  }
  return ARC_TESTNET;
}

/** The browser client for this store, or null when payments are off (or during SSR). */
export function makePolaris(config: BrowserPolarisConfig): Polaris | null {
  if (!config.ok || typeof window === "undefined") return null;
  return createPolaris({
    publishableKey: config.publishableKey,
    checkoutOrigin: config.checkoutOrigin,
    relayUrl: config.relayUrl,
    chain: chainFor(config),
  });
}

"use client";

/**
 * React entry point: `import { PolarisCheckoutButton } from "polarispay-sdk/react"`.
 *
 * Kept separate from the root export so that React stays an optional peer
 * dependency in fact and not just in package.json. Every component renders
 * its own styles (no stylesheet import), themes through `--polaris-*` CSS
 * custom properties, and renders on the server.
 */

export { PolarisCheckoutButton } from "./react/PolarisCheckoutButton.js";
export type {
  CheckoutSessionLike,
  PolarisButtonSize,
  PolarisButtonTheme,
  PolarisCheckoutButtonProps,
} from "./react/PolarisCheckoutButton.js";
export { PolarisMessaging } from "./react/PolarisMessaging.js";
export type { PolarisMessagingProps } from "./react/PolarisMessaging.js";
export { PolarisPayButton } from "./react/PolarisPayButton.js";
export type { PolarisPayButtonProps } from "./react/PolarisPayButton.js";
export { usePolarisCheckout } from "./react/usePolarisCheckout.js";
export type { CheckoutStatus, UsePolarisCheckout, UsePolarisCheckoutOptions } from "./react/usePolarisCheckout.js";
export { PolarisProvider, usePolaris, usePolarisClient } from "./react/context.js";
export type { PolarisClientProps, PolarisProviderProps } from "./react/context.js";
export { PolarisMark } from "./react/PolarisMark.js";
export type { PolarisMarkProps } from "./react/PolarisMark.js";
export { PolarisStyles } from "./react/styles.js";

// 0.2
export { PayWithPolarisBNPL, POLARIS_SEPOLIA } from "./components/PayWithPolarisBNPL.js";
export type { PayWithPolarisBNPLProps } from "./components/PayWithPolarisBNPL.js";

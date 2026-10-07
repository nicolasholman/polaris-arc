import { orderStoreKind, type OrderStoreKind } from "./orders/store";
import { resolvePolarisConfig } from "./polaris";

/**
 * What GET /api/health reports: that the store is up and how it is wired to
 * Polaris, for scripts/deploy-check.mjs. Never a secret: the API and checkout
 * origins, the payout address (direct wallet payments pay it in the open),
 * whether the publishable key is a test or live one, and where orders are
 * kept. A value that isn't a URL is reported as null rather than echoed.
 */

export type ShopHealth = {
  ok: true;
  service: "halcyon-shop";
  production: boolean;
  /** Polaris for Business, which every payment goes through; or why payments aren't configured. */
  polaris:
    | {
        configured: true;
        apiBase: string | null;
        checkoutOrigin: string | null;
        relayUrl: string | null;
        merchant: string;
        publishableKeyMode: "test" | "live" | "unknown";
      }
    | { configured: false; reason: string };
  /** SHOP_URL: where success and cancel URLs point. */
  shopUrl: string | null;
  orderStore: { kind: OrderStoreKind; serverless: boolean };
};

function originOf(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

export function shopHealth(env: Record<string, string | undefined> = process.env): ShopHealth {
  const config = resolvePolarisConfig(env);
  return {
    ok: true,
    service: "halcyon-shop",
    production: env.NODE_ENV === "production",
    polaris: config.ok
      ? {
          configured: true,
          apiBase: originOf(config.baseUrl),
          checkoutOrigin: originOf(config.checkoutOrigin),
          relayUrl: config.relayUrl,
          merchant: config.merchant,
          publishableKeyMode: config.publishableKey.startsWith("pk_test_") ? "test" : config.publishableKey.startsWith("pk_live_") ? "live" : "unknown",
        }
      : { configured: false, reason: config.reason },
    shopUrl: originOf(env.SHOP_URL),
    orderStore: { kind: orderStoreKind(env), serverless: env.VERCEL === "1" },
  };
}

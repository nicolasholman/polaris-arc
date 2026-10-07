// Seed a merchant, an API key pair and (optionally) a webhook endpoint
// straight into the Polaris for Business store, for local development and the
// end-to-end run, where there is no Privy login to create them through the
// dashboard. Uses the same @polaris/db code and key hashing as the server, so
// the server accepts the keys it prints.

import {
  collections,
  hashSecretKey,
  keyHint,
  newId,
  newMerchantRecord,
  newPublishableKey,
  newSecretKey,
  newWebhookSecret,
  openStore,
  WEBHOOK_EVENT_TYPES,
} from "@polaris/db";
import { getAddress } from "viem";

/**
 * @param {{ dbUrl: string; pepper: string | undefined; wallet: string; name: string;
 *           webhookUrl?: string; registration?: "none" | "registered" | "active" }} input
 */
export async function seedMerchant(input) {
  if (process.env.NODE_ENV === "production") throw new Error("Local seeding is for development only.");
  const store = openStore(input.dbUrl);
  try {
    const db = collections(store);
    const wallet = getAddress(input.wallet);
    const id = `dev:${wallet.toLowerCase()}`;
    let merchant = await db.merchants.get(id);
    if (!merchant) {
      merchant = newMerchantRecord({ id, walletAddress: wallet, businessName: input.name, email: null });
      merchant.registration.state = input.registration ?? "none";
      await db.merchants.insert(merchant);
    }
    const secret = newSecretKey("test");
    const key = {
      id: newId("key", 16),
      merchantId: merchant.id,
      name: "Local development",
      livemode: false,
      publishableKey: newPublishableKey("test"),
      secretHint: keyHint(secret),
      secretHash: hashSecretKey(secret, input.pepper),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await db.apiKeys.insert(key);
    let webhook = null;
    if (input.webhookUrl) {
      const whsec = newWebhookSecret();
      webhook = {
        id: newId("we", 16),
        merchantId: merchant.id,
        url: input.webhookUrl,
        events: [...WEBHOOK_EVENT_TYPES],
        secret: whsec,
        secretHint: keyHint(whsec),
        createdAt: new Date().toISOString(),
        disabledAt: null,
      };
      await db.webhookEndpoints.insert(webhook);
    }
    return { merchant, secretKey: secret, publishableKey: key.publishableKey, webhookSecret: webhook?.secret ?? null, webhookId: webhook?.id ?? null };
  } finally {
    store.close();
  }
}

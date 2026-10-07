import { inboxRegistrationMessage, toHex } from "@polaris/receipts";
import type { Address, Hex, LocalAccount } from "viem";
import { api, apiConfigured } from "../api";

/**
 * Registering the receipts inbox key with Polaris for Business.
 *
 * Face ID derives the inbox key pair with the wallet key (account/mera.ts);
 * the public half goes to `POST /api/receipts/inbox` with the account's
 * EIP-191 signature over it, made with the session that just opened (no
 * prompt). The server never takes the ceremony itself as proof of anything.
 * From then on, what the account buys is sealed to that key when it settles.
 *
 * Once per account and key per page load, in the background: a failure is
 * retried at the next sign-in, and anything that settled in between is
 * sealed when the registration lands (the server seals the backlog).
 */

type Registration = { key: Hex; done: Promise<boolean> };
const registrations = new Map<string, Registration>();

export function registerInbox(account: LocalAccount, inboxPublicKey: Uint8Array): Promise<boolean> {
  if (!apiConfigured()) return Promise.resolve(false);
  const owner = account.address.toLowerCase();
  const key = toHex(inboxPublicKey);
  const known = registrations.get(owner);
  if (known && known.key === key) return known.done;
  const done = (async () => {
    const signature = await account.signMessage({ message: inboxRegistrationMessage(key) });
    // A slow or briefly unreachable server: try again a little later, twice, before leaving it to the next sign-in.
    for (const wait of [0, 2_000, 8_000]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        await api(`/api/receipts/inbox`, { method: "POST", body: { address: account.address, inboxPublicKey: key, signature } });
        return true;
      } catch (error) {
        // A refusal (a bad signature, a malformed key) won't change on a retry.
        const status = (error as { status?: number }).status ?? 0;
        if (status >= 400 && status < 500 && status !== 429) throw error;
      }
    }
    throw new Error("The receipts inbox couldn't be registered");
  })().catch(() => {
    // Not fatal: receipts stay in the clear on the server until the next sign-in registers.
    if (registrations.get(owner)?.done === done) registrations.delete(owner);
    return false;
  });
  registrations.set(owner, { key, done });
  return done;
}

/**
 * Before a checkout relays: let a registration that is still in flight land
 * first (at most `timeoutMs`), so the payment is sealed as it settles. It
 * never blocks a payment for long, and never fails one.
 */
export async function inboxReady(owner: Address, timeoutMs = 4_000): Promise<void> {
  const pending = registrations.get(owner.toLowerCase());
  if (!pending) return;
  await Promise.race([pending.done, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

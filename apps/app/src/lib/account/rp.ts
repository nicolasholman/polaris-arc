import { env } from "../env";
import { AccountError } from "./errors";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The WebAuthn relying party id. A passkey, and so the account derived from
 * it, belongs to this id forever.
 *
 * `NEXT_PUBLIC_RP_ID` when set (production: `polarispay.app`, so `app.` and
 * `pay.` share one account per person). Otherwise the page's hostname, which
 * is `localhost` in dev.
 *
 * WebAuthn requires the page's host to be the rpId or a subdomain of it, and
 * refuses IP addresses. Checking here turns an opaque `SecurityError` into
 * something the UI can explain.
 */
export function resolveRpId(): string {
  if (typeof window === "undefined") throw new AccountError("host", "No window: accounts are browser-only");
  const host = window.location.hostname;
  const rpId = (env.rpId ?? host).toLowerCase();
  if (!rpId || IPV4.test(rpId) || rpId.includes(":")) {
    throw new AccountError("host", `WebAuthn needs a domain name, not ${rpId || "an empty host"}`);
  }
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    throw new AccountError("host", `Accounts for ${rpId} can't be used on ${host}`);
  }
  return rpId;
}

/** Same as `resolveRpId` but null instead of throwing. */
export function tryRpId(): string | null {
  try {
    return resolveRpId();
  } catch {
    return null;
  }
}

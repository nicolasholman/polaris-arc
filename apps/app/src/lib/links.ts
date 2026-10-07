import { type Hex, isHex } from "viem";
import { amountParam, type Currency, type Micros, parseAmount } from "./money.ts";

/**
 * Your receive link (`/send?to=<account>&n=<name>`, what your code holds) and
 * how it reads on screen: the site and your name, never the account's 0x
 * address. The real URL is only ever copied, shared or put in the code.
 */
export function receiveLink(origin: string, address: string, name: string): { url: string; shown: string } {
  const url = `${origin}/send?${new URLSearchParams({ to: address, ...(name ? { n: name } : {}) }).toString()}`;
  return { url, shown: `${origin.replace(/^https?:\/\//, "")}/send · ${name || "your link"}` };
}

/** A link slug, a payment link id (`pl_…`) or a checkout session id (`cs_test_…`). */
const ID = /^[a-z0-9][a-z0-9_-]{1,135}$/i;

/**
 * Turns whatever the buyer scanned or pasted into a path inside this app, or
 * null. Only Polaris destinations are accepted: a code can never send the
 * buyer to another site.
 *
 *   https://app.polarispay.app/pay/sol-brand   → /pay/sol-brand
 *   https://pay.polarispay.app/sol-brand       → /pay/sol-brand
 *   https://<this origin>/claim#k=…            → /claim#k=…
 *   https://<this origin>/send?to=…            → /send?to=…
 *   https://<this origin>/split/0x…#d=…        → /split/0x…#d=…  (a split's words stay in the fragment)
 *   sol-brand                                  → /pay/sol-brand
 *   https://pay.polarispay.app/pay/cs_test_…   → /pay/cs_test_…  (a checkout session)
 */
export function toAppPath(input: string, origin: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (ID.test(text)) return `/pay/${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const trusted =
    url.origin === origin || url.hostname === "polarispay.app" || url.hostname.endsWith(".polarispay.app");
  if (!trusted || (url.protocol !== "https:" && url.origin !== origin)) return null;

  if (url.hostname === "pay.polarispay.app") {
    // Both pay.polarispay.app/<id> and the SDK's pay.polarispay.app/pay/<id>.
    const id = url.pathname.replace(/^\/+|\/+$/g, "").replace(/^pay\//, "");
    return ID.test(id) ? `/pay/${id}` : null;
  }
  const pay = url.pathname.match(/^\/pay\/([a-z0-9][a-z0-9_-]{1,135})\/?$/i);
  if (pay) return `/pay/${pay[1]}`;
  if (url.pathname === "/claim" && url.hash.length > 1) return `/claim${url.hash}`;
  const split = url.pathname.match(/^\/split\/(0x[0-9a-f]{64})\/?$/i);
  if (split) return `/split/${split[1]!.toLowerCase()}${url.hash}`;
  if (url.pathname === "/send" && url.search) return `/send${url.search}`;
  return null;
}

/* ── Send links ─────────────────────────────────────────────────────────── */

/** What a send link carries: the link's key, the amount, the sender's name, and the currency. */
export type ClaimFragment = { key: Hex; amount: Micros; name: string; currency: Currency };

/**
 * A send link: `/claim#k=<key>&a=<amount>&n=<name>`, plus `&c=EUR` for a link
 * in euros (EURC, the PolarisSend on EURC). No `c` means dollars, so every
 * link made before euros still claims. The fragment never leaves the browser.
 */
export function claimUrl(origin: string, link: ClaimFragment): string {
  const fragment = new URLSearchParams({ k: link.key, a: amountParam(link.amount), n: link.name, ...(link.currency === "EUR" ? { c: "EUR" } : {}) });
  return `${origin}/claim#${fragment.toString()}`;
}

/** A send link's fragment, or `{ invalid: true }` when part of it is missing or malformed. */
export function parseClaimFragment(hash: string): ClaimFragment | { invalid: true } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const key = params.get("k") ?? "";
  const amount = parseAmount(params.get("a") ?? "");
  // Display text from a link: strip control characters, cap the length.
  const name = (params.get("n") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  const c = (params.get("c") ?? "USD").toUpperCase();
  if (!isHex(key) || key.length !== 66 || amount === null || amount <= 0n || (c !== "USD" && c !== "EUR")) return { invalid: true };
  return { key, amount, name: name || "Someone", currency: c };
}

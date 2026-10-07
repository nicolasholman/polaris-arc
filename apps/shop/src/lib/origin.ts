import { headers } from "next/headers";

/**
 * The store's public origin, for success URLs and absolute image URLs.
 *
 * SHOP_URL pins it (and production requires it: see resolvePolarisConfig).
 * Otherwise it comes from the request's Host. X-Forwarded-Host and
 * X-Forwarded-Proto are only believed when TRUST_PROXY=1 says a proxy in
 * front of the store sets them; anyone can send them otherwise.
 */
export function requestOrigin(req: Request): string {
  const pinned = process.env.SHOP_URL?.trim();
  if (pinned) return new URL(pinned).origin;
  if (process.env.TRUST_PROXY === "1") {
    const forwardedHost = req.headers.get("x-forwarded-host");
    if (forwardedHost) return `${req.headers.get("x-forwarded-proto") ?? "https"}://${forwardedHost}`;
  }
  return new URL(req.url).origin;
}

/** The same, from a server component. */
export async function pageOrigin(): Promise<string> {
  const pinned = process.env.SHOP_URL?.trim();
  if (pinned) return new URL(pinned).origin;
  const h = await headers();
  const proxied = process.env.TRUST_PROXY === "1";
  const host = (proxied ? h.get("x-forwarded-host") : null) ?? h.get("host") ?? "localhost:3600";
  const local = host.startsWith("localhost") || host.startsWith("127.") || host.startsWith("[::1]");
  const proto = (proxied ? h.get("x-forwarded-proto") : null) ?? (local ? "http" : "https");
  return `${proto}://${host}`;
}

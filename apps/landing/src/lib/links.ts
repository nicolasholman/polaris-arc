/**
 * Where the page's calls to action lead once the other apps are deployed.
 * Each is set per deployment (NEXT_PUBLIC_*, inlined when the page is built);
 * unset, the link stays on this page (an in-page anchor), so a local build
 * never points at a host that doesn't exist.
 */

function base(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
}

/** The Polaris app (apps/app): "Get the app". */
export const APP_URL = base(process.env.NEXT_PUBLIC_APP_URL);

/** Polaris for Business (apps/business): "Log in" and "Start accepting". */
export const BUSINESS_URL = base(process.env.NEXT_PUBLIC_BUSINESS_URL);

/** `url` + `path` when the app is deployed, else the in-page anchor. */
export function linkTo(url: string | null, path: string, fallback: string): string {
  return url ? `${url}${path}` : fallback;
}

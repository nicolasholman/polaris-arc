/** The pages that used to live at the top level, before the dashboard moved under /dashboard. */
const LEGACY = ["/payments", "/links", "/plans", "/payouts", "/developers"];

/**
 * Where to go after signing in. Only same-site dashboard paths: `next` must
 * never become an open redirect, and the old top-level paths still arrive in
 * links people saved.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/dashboard";
  // Resolve dot segments first ("/dashboard/../api/health"), then check the
  // path that would actually load.
  let path: string;
  try {
    const url = new URL(raw, "http://x");
    if (url.origin !== "http://x") return "/dashboard";
    path = url.pathname + url.search;
  } catch {
    return "/dashboard";
  }
  const legacy = LEGACY.find((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`));
  if (legacy) return `/dashboard${path}`;
  if (path === "/dashboard" || path.startsWith("/dashboard/") || path.startsWith("/dashboard?")) return path;
  return "/dashboard";
}

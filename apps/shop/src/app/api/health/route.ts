import { shopHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

/** GET /api/health: the store is up, and how it's wired to Polaris (src/lib/health.ts). No secrets. */
export function GET(): Response {
  return Response.json(shopHealth(), { headers: { "cache-control": "no-store" } });
}

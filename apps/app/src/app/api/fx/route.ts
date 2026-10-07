import { createFxService, type FxService, handleFxRequest } from "@polaris/fx";

/**
 * GET /api/fx?currency=ARS: the Chainlink rate behind the local-currency line.
 *
 * Returns an `FxLookup` from `@polaris/fx`: `{ currency, status: "ok", rate }`
 * with `rate.perUsd` (local units per dollar), `rate.updatedAt` (unix seconds)
 * and the feed it came from; or `{ currency, status, rate: null }` with status
 * `no-feed`, `stale` (older than 26 h) or `unavailable`, and the app shows no
 * line. 400 for anything but a three-letter code. Public data only, read
 * server-side from public RPCs (override with FX_RPC_MONAD, FX_RPC_ETHEREUM,
 * FX_RPC_POLYGON, FX_RPC_BASE) and cached for five minutes, so a page view
 * costs at most one read per currency.
 */

export const dynamic = "force-dynamic";

// One service per server process, kept across dev reloads so its cache survives.
const globalFx = globalThis as typeof globalThis & { polarisFx?: FxService };
const fx = (globalFx.polarisFx ??= createFxService({
  onSourceError: (source, error) => {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.warn(`[fx] skipped ${source.pair} on ${source.chain} (${source.address}): ${reason}`);
  },
}));

export function GET(request: Request): Promise<Response> {
  return handleFxRequest(fx, request);
}

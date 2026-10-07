import { withPublic } from "@/server/auth";
import { ok, methodNotAllowed } from "@/server/http";
import { readiness } from "@/server/readiness";

export const dynamic = "force-dynamic";

/**
 * Readiness: 200 when this process can take traffic, 503 when it can't
 * (the environment doesn't parse, no chain, the store can't be read or its
 * volume isn't writable, or the background loops didn't start). Fly's health
 * check and the Docker image's HEALTHCHECK call it; `scripts/deploy-check.mjs`
 * reads the details. No network call and no secret: the relayer's mode and
 * the chain sync's age are reported, never waited on.
 */
export const GET = withPublic(async () => {
  const state = await readiness();
  return ok(state, state.ready ? 200 : 503);
}, { limit: "health" });

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withPublic(notAllowed, { limit: "health" });
export const PUT = withPublic(notAllowed, { limit: "health" });
export const PATCH = withPublic(notAllowed, { limit: "health" });
export const DELETE = withPublic(notAllowed, { limit: "health" });

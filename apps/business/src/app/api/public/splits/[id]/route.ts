import type { Hex } from "viem";

import { withPreflight, withPublic } from "@/server/auth";
import { HttpError, methodNotAllowed, ok } from "@/server/http";
import { splitView } from "@/server/split";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A split-the-bill link's status, for the Polaris app's split page: who
 * organised it, each share's amount and whether (and when) it was paid, and
 * whether it is open, settled, closed or expired. The chain's own state
 * (PolarisSplit `splitOf`, `sharesOf`) with the times and transactions the
 * chain sync saw (src/server/split.ts).
 *
 * Only what the chain already shows. The split's words (what it is for, the
 * names) travel in the link and never reach this server; `memoHash` is what
 * the app checks the link's words against.
 */
export const GET = withPublic<Ctx>(async (_req, _auth, { params }) => {
  const { id } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new HttpError(400, "invalid_request", "id must be a split id (32 bytes of hex).", { param: "id" });
  const view = await splitView(id.toLowerCase() as Hex);
  if (!view) throw new HttpError(404, "split_not_found", "We couldn't find that split.");
  return ok(view);
});

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);

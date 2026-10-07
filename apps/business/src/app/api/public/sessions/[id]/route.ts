import { getAddress, isAddress } from "viem";

import { withPreflight, withPublic } from "@/server/auth";
import { HttpError, ok, methodNotAllowed } from "@/server/http";
import { assertSessionId } from "@/server/sessions/params";
import { publicSession } from "@/server/sessions/sessions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * What the hosted checkout (the Polaris app at /pay/{id}) reads: the price,
 * the ways to pay, the Pay in 4 schedule, and the exact on-chain terms the
 * buyer signs. No secrets, no metadata, nothing about the merchant beyond
 * their name and payout address. `?buyer=0x…` adds that buyer's current
 * nonces and Pay in 4 quote (public chain state), so the app can sign
 * without its own RPC reads.
 */
export const GET = withPublic<Ctx>(async (req, _auth, { params }) => {
  const { id } = await params;
  const raw = new URL(req.url).searchParams.get("buyer");
  if (raw !== null && !isAddress(raw, { strict: false })) throw new HttpError(400, "invalid_request", "buyer must be an address.", { param: "buyer" });
  return ok(await publicSession(assertSessionId(id), { buyer: raw ? getAddress(raw) : null }));
});

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);

import { getAddress, isAddress } from "viem";

import { withPreflight, withPublic } from "@/server/auth";
import { creditStatus } from "@/server/credit/underwriting";
import { HttpError, methodNotAllowed, ok } from "@/server/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ account: string }> };

/**
 * Where an account's credit stands: its line and score read from
 * ScoreManager now, its latest underwriting request, and what the CRE
 * workflow decided (with its reasons). Public chain state and the account's
 * own request, nothing else.
 */
export const GET = withPublic<Ctx>(async (_req, _auth, { params }) => {
  const { account } = await params;
  if (!isAddress(account, { strict: false })) throw new HttpError(400, "invalid_request", "account must be an address.", { param: "account" });
  return ok(await creditStatus(getAddress(account)));
});

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);

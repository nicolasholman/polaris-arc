import { getAddress, isAddress } from "viem";

import { withPreflight, withPublic } from "@/server/auth";
import { consentMessages } from "@/server/credit/underwriting";
import { HttpError, methodNotAllowed, ok } from "@/server/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ account: string }> };

/**
 * The exact texts to sign before `POST /api/credit/underwrite`, with a fresh
 * nonce and issue time (good for 15 minutes): the account's consent, and with
 * `?wallet=0x…` the history wallet's link proof. They are the texts the CRE
 * workflow verifies inside the DON.
 */
export const GET = withPublic<Ctx>(async (req, _auth, { params }) => {
  const { account } = await params;
  if (!isAddress(account, { strict: false })) throw new HttpError(400, "invalid_request", "account must be an address.", { param: "account" });
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (wallet !== null && !isAddress(wallet, { strict: false })) throw new HttpError(400, "invalid_request", "wallet must be an address.", { param: "wallet" });
  return ok(consentMessages(getAddress(account), wallet ? getAddress(wallet) : null));
});

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);

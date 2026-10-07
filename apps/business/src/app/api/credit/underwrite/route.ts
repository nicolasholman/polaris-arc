import { withPreflight, withSignedRequest } from "@/server/auth";
import { requestUnderwriting } from "@/server/credit/underwriting";
import { methodNotAllowed, ok, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Ask for a Pay in 4 credit line: queue a run of the CRE underwriting
 * workflow for this account. The credential is the account's own EIP-191
 * signature over its consent (and, to bring history, the history wallet's
 * over its link proof), both from `GET /api/public/credit/{account}/messages`.
 * Answers 202 with the queued request; `GET /api/public/credit/{account}`
 * follows it to the decision.
 *
 *   { "account": "0x…", "consent": { "issuedAt": 1790000000, "nonce": "…", "signature": "0x…" },
 *     "linked": { "wallet": "0x…", "issuedAt": 1790000000, "nonce": "…", "signature": "0x…" } }
 */
export const POST = withSignedRequest(async (req) => {
  const result = await requestUnderwriting(await readJson(req));
  return ok(result, result.duplicate ? 200 : 202);
});

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withSignedRequest(notAllowed);
export const PUT = withSignedRequest(notAllowed);
export const PATCH = withSignedRequest(notAllowed);
export const DELETE = withSignedRequest(notAllowed);

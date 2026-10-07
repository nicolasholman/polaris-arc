import { withSecretKey } from "@/server/auth";
import { afterResponse } from "@/server/background";
import { ok, readJson, methodNotAllowed } from "@/server/http";
import { fingerprint, withIdempotency } from "@/server/sessions/idempotency";
import { parseCreateSession } from "@/server/sessions/params";
import { createSession, ensureSubscriptionPlan, toApiSession } from "@/server/sessions/sessions";

export const dynamic = "force-dynamic";

/**
 * `polaris.checkout.sessions.create` (polarispay-sdk/server).
 *
 * Secret key only. The body is exactly the SDK's (packages/sdk README, "HTTP
 * API"); `Idempotency-Key` makes retries safe: the same key and body returns
 * the first session with 200, a different body 409 `idempotency_key_reused`.
 */
export const POST = withSecretKey(async (req, { merchant, key }) => {
  const body = await readJson(req, { maxBytes: 64 * 1024 });
  const input = parseCreateSession(body);
  const result = await withIdempotency(`sessions:${merchant.id}`, req.headers.get("idempotency-key"), fingerprint(body), async () => {
    const session = await createSession(merchant, input, { livemode: key.livemode });
    if (session.modes.includes("subscribe")) {
      // Publish the subscription plan on chain now, so the checkout doesn't wait for it.
      afterResponse("sessions: subscription plan", () => ensureSubscriptionPlan(session));
    }
    return { status: 201, body: toApiSession(session) };
  });
  return ok(result.body, result.replayed ? 200 : result.status);
});

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withSecretKey(notAllowed);
export const PUT = withSecretKey(notAllowed);
export const PATCH = withSecretKey(notAllowed);
export const DELETE = withSecretKey(notAllowed);

import { withMerchant } from "@/server/auth";
import { ok, readJson, methodNotAllowed } from "@/server/http";
import { getPayouts, withdraw } from "@/server/services";
import { parseWithdraw } from "@/server/validate";

export const dynamic = "force-dynamic";

/** Balance, automatic payout settings and payout history. */
export const GET = withMerchant(async (_req, auth) => ok(await getPayouts(auth)));

/**
 * Withdraw to an address. The source is always the caller's own embedded
 * wallet, as Privy reports it; the body names only the amount and destination.
 */
export const POST = withMerchant(async (req, auth) => {
  const input = parseWithdraw(await readJson(req));
  return ok(await withdraw(auth, input), 201);
});

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET", "POST"]);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);

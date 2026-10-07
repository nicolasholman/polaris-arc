import { withPreflight, withPublic } from "@/server/auth";
import { creditGuard } from "@/server/cre/guardian";
import { methodNotAllowed, ok } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * The credit guard: whether new Pay in 4 plans can open right now
 * (PolarisCheckout.creditPaused, which openPlan applies), why not, and when
 * the Chainlink CRE guardian workflow last checked the pool. Public chain
 * state only. The Polaris app, the hosted checkout and merchants' shops read
 * it to say "Pay in 4 is paused by our risk guard; pay now works as usual"
 * instead of letting a buyer sign a plan that would revert.
 */
export const GET = withPublic(async () => ok(await creditGuard()));

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);

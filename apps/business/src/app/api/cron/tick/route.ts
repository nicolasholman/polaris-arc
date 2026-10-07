import { withCron } from "@/server/auth";
import { ok, methodNotAllowed } from "@/server/http";
import { runTick } from "@/server/workers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One pass of the background work (chain sync, late receipts, webhook
 * deliveries and retries, automatic payouts), for schedulers.
 * `Authorization: Bearer <CRON_SECRET>`; GET for Vercel Cron, POST for others.
 */
export const GET = withCron(async () => ok(await runTick()));
export const POST = withCron(async () => ok(await runTick()));

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET", "POST"]);
export const PUT = withCron(notAllowed);
export const PATCH = withCron(notAllowed);
export const DELETE = withCron(notAllowed);

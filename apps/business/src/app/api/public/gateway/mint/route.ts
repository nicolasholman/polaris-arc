import { withPreflight, withPublic } from "@/server/auth";
import { gatewayMint } from "@/server/gateway";
import { methodNotAllowed, ok, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Circle Gateway: spend a unified balance on Arc. Body `{ burnIntent,
 * signature }`. Circle's Gateway API attests the signed intent, and the
 * relayer calls GatewayMinter.gatewayMint on Arc, paying the gas in USDC;
 * the USDC lands in the recipient the buyer signed for (server/gateway.ts).
 */
export const POST = withPublic(async (req) => ok(await gatewayMint(await readJson(req))));

export const OPTIONS = withPreflight("app");

const notAllowed = methodNotAllowed(["POST"]);
export const GET = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);

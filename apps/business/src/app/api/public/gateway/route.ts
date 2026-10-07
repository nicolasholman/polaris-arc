import { withPreflight, withPublic } from "@/server/auth";
import { gatewayBalances } from "@/server/gateway";
import { methodNotAllowed, ok } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Circle Gateway: where a buyer's unified USDC balance is, per chain
 * (`?depositor=0x…`), and the GatewayWallet to deposit into. Without a
 * depositor: whether Gateway runs on this network, and on which chains.
 */
export const GET = withPublic(async (req) => ok(await gatewayBalances(new URL(req.url).searchParams.get("depositor"))));

export const OPTIONS = withPreflight("app");

const notAllowed = methodNotAllowed(["GET"]);
export const POST = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);

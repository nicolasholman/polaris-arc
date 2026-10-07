import { withPreflight, withPublic } from "@/server/auth";
import { gatewayIntent } from "@/server/gateway";
import { methodNotAllowed, ok, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Circle Gateway: the EIP-712 burn intent a buyer signs to spend their
 * unified balance on Arc. Body `{ depositor, sourceDomain, recipient,
 * amountUnits }`. Nothing moves until the signed intent is posted to
 * `/api/public/gateway/mint`.
 */
export const POST = withPublic(async (req) => ok(gatewayIntent(await readJson(req))));

export const OPTIONS = withPreflight("app");

const notAllowed = methodNotAllowed(["POST"]);
export const GET = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);

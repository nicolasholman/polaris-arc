import { withPreflight, withPublic } from "@/server/auth";
import { mintFromBurn } from "@/server/cctp";
import { methodNotAllowed, ok, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Pay from any chain: finish a CCTP V2 transfer into Arc. Body
 * `{ sourceDomain, txHash }` (the burn on the source chain). Idempotent: the
 * app polls it until `status` is "minted". The relayer pays Arc's gas in
 * USDC; Circle's attestation decides who receives what (server/cctp.ts).
 */
export const POST = withPublic(async (req) => {
  return ok(await mintFromBurn(await readJson(req)));
});

export const OPTIONS = withPreflight("app");

const notAllowed = methodNotAllowed(["POST"]);
export const GET = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);

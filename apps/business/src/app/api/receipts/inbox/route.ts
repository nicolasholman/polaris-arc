import { withPreflight, withSignedRequest } from "@/server/auth";
import { methodNotAllowed, ok, readJson } from "@/server/http";
import { registerInbox } from "@/server/receipts";

export const dynamic = "force-dynamic";

/**
 * Register the receipts inbox key a buyer's Face ID derives (the public half
 * of an X25519 key pair, @polaris/receipts). The credential is the account's
 * own EIP-191 signature over `Polaris receipts key <inboxPublicKey>`: a Face
 * ID ceremony proves nothing to a server by itself. Registering also seals
 * whatever this buyer's records still hold in the clear.
 *
 *   { "address": "0x…", "inboxPublicKey": "0x…64 hex", "signature": "0x…" }
 */
export const POST = withSignedRequest(async (req) => ok(await registerInbox(await readJson(req))));

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withSignedRequest(notAllowed);
export const PUT = withSignedRequest(notAllowed);
export const PATCH = withSignedRequest(notAllowed);
export const DELETE = withSignedRequest(notAllowed);

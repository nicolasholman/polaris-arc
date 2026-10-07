import { withPreflight, withSignedRequest } from "@/server/auth";
import { methodNotAllowed, ok, readJson } from "@/server/http";
import { readReceipts } from "@/server/receipts";

export const dynamic = "force-dynamic";

/**
 * A buyer's sealed receipts: ciphertext only their Face ID opens (RFC 9180
 * HPKE to their inbox key, src/server/receipts.ts). The credential is the
 * account's own EIP-191 signature over `receiptsReadMessage(address,
 * issuedAt)` (@polaris/receipts), at most five minutes old: the app signs
 * it with the session Face ID already opened.
 *
 *   { "address": "0x…", "issuedAt": 1790000000, "signature": "0x…" }
 *
 * Answers `{ address, inboxPublicKey, receipts: [{ id, kind, enc, ct, txHash, amountUnits, createdAt }] }`, newest first.
 */
export const POST = withSignedRequest(async (req) => ok(await readReceipts(await readJson(req))));

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withSignedRequest(notAllowed);
export const PUT = withSignedRequest(notAllowed);
export const PATCH = withSignedRequest(notAllowed);
export const DELETE = withSignedRequest(notAllowed);

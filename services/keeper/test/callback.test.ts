import assert from "node:assert/strict";
import { test } from "node:test";

import { sign, verify } from "../src/callback.ts";
import { evidenceStaleness, parseReviewRequest, underwriteConsentMessage } from "../src/underwriting.ts";

test("signs like a merchant webhook and verifies its own signature, within five minutes", () => {
  const body = JSON.stringify({ id: "x", type: "collections.run" });
  const header = sign("s3cret", body, 1_700_000_000);
  assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.deepEqual(verify("s3cret", body, header, 1_700_000_100), { ok: true });
  assert.equal(verify("other", body, header, 1_700_000_100).ok, false);
  assert.equal(verify("s3cret", body + " ", header, 1_700_000_100).ok, false);
  assert.equal(verify("s3cret", body, header, 1_700_000_400).ok, false);
  assert.equal(verify("s3cret", body, null, 1_700_000_000).ok, false);
});

test("the consent text is the business's, byte for byte", () => {
  const text = underwriteConsentMessage({
    account: "0x00000000000000000000000000000000000000Aa",
    wallet: null,
    chainId: 5042002,
    issuedAt: 1_700_000_000,
    nonce: "abcdefgh",
  });
  assert.equal(
    text,
    [
      "Polaris: underwrite this account for Pay in 4 credit, once, from the evidence below.",
      "",
      "Account: 0x00000000000000000000000000000000000000aa",
      "History wallet: none",
      "Chain: 5042002",
      "Issued: 2023-11-14T22:13:20Z",
      "Nonce: abcdefgh",
    ].join("\n"),
  );
  assert.equal(evidenceStaleness(1_000, 1_000 + 15 * 60), null);
  assert.equal(evidenceStaleness(1_000, 1_000 + 15 * 60 + 1), "older than 15 minutes");
});

test("a review request must carry the account, a well-formed consent and, if linked, another wallet", () => {
  const sig = `0x${"11".repeat(65)}`;
  const ok = parseReviewRequest({ input: { user: "0x00000000000000000000000000000000000000aa", consent: { issuedAt: 1, nonce: "abcdefgh", signature: sig }, linked: null } });
  assert.equal(ok.linked, null);
  assert.throws(() => parseReviewRequest({}), /input/);
  assert.throws(() => parseReviewRequest({ input: { user: "nope" } }), /address/);
  assert.throws(
    () =>
      parseReviewRequest({
        input: {
          user: "0x00000000000000000000000000000000000000aa",
          consent: { issuedAt: 1, nonce: "abcdefgh", signature: sig },
          linked: { wallet: "0x00000000000000000000000000000000000000aa", issuedAt: 1, nonce: "abcdefgh", signature: sig },
        },
      }),
    /another wallet/,
  );
});

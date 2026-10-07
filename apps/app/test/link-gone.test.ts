import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LINK_GONE_TEXT, linkGoneReason } from "../src/lib/link-gone.ts";

/**
 * R1 A7: a payment link its merchant turned off showed the generic "It may
 * have expired" although Polaris for Business answers 410 `link_inactive`
 * (apps/business test/web-audit.test.ts checks the codes). The checkout now
 * says which.
 */
describe("linkGoneReason", () => {
  it("reads Polaris for Business's 410 codes", () => {
    assert.equal(linkGoneReason({ status: 410, code: "link_inactive" }), "inactive");
    assert.equal(linkGoneReason({ status: 410, code: "link_expired" }), "expired");
    assert.equal(linkGoneReason({ status: 410, code: "session_expired" }), "expired");
    assert.equal(linkGoneReason({ status: 410, code: "link_used" }), "used");
    assert.equal(linkGoneReason({ status: 410, code: "something_new" }), "not_found");
    assert.equal(linkGoneReason({ status: 404, code: "not_found" }), "not_found");
  });

  it("isn't a reason for anything else: a 500 or a network error is an error, not a missing link", () => {
    assert.equal(linkGoneReason({ status: 500, code: "internal" }), null);
    assert.equal(linkGoneReason(new TypeError("fetch failed")), null);
    assert.equal(linkGoneReason(null), null);
  });

  it("says a turned-off link was turned off by its business, not that it may have expired", () => {
    assert.match(LINK_GONE_TEXT.inactive.title, /turned off/);
    assert.match(LINK_GONE_TEXT.inactive.description, /business that made it turned it off/);
    assert.doesNotMatch(LINK_GONE_TEXT.inactive.description, /expired/);
    assert.match(LINK_GONE_TEXT.expired.title, /expired/);
  });
});

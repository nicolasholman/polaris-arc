import { describe, expect, it } from "vitest";

import { createCheckoutMessage, parseCheckoutMessage } from "../src/checkout/protocol.js";
import { parseKey } from "../src/keys.js";

describe("checkout postMessage protocol", () => {
  it("round-trips every event", () => {
    expect(parseCheckoutMessage(createCheckoutMessage("ready", "cs_test_1"))).toEqual({ kind: "ready", sessionId: "cs_test_1" });
    expect(parseCheckoutMessage(createCheckoutMessage("canceled", "cs_test_1"))).toEqual({
      kind: "result",
      sessionId: "cs_test_1",
      result: { status: "canceled", sessionId: "cs_test_1" },
    });
    expect(parseCheckoutMessage(createCheckoutMessage("expired", "cs_test_1"))).toMatchObject({ result: { status: "expired" } });
    expect(
      parseCheckoutMessage(createCheckoutMessage("completed", "cs_test_1", { mode: "subscribe", subscriptionId: "4", txHash: "0x01" })),
    ).toEqual({
      kind: "result",
      sessionId: "cs_test_1",
      result: {
        status: "completed",
        sessionId: "cs_test_1",
        mode: "subscribe",
        orderId: null,
        txHash: "0x01",
        paymentId: null,
        planId: null,
        subscriptionId: "4",
      },
    });
  });

  it("ignores anything else on the page's message bus", () => {
    for (const noise of [
      null,
      "polaris:checkout",
      42,
      { type: "metamask:provider" },
      { type: "polaris:checkout", version: 2, event: "completed", sessionId: "x", mode: "now" },
      { type: "polaris:checkout", version: 1, event: "hacked", sessionId: "x" },
      { type: "polaris:checkout", version: 1, event: "completed", sessionId: "x", mode: "free" },
      { type: "polaris:payment", status: "pending" },
    ]) {
      expect(parseCheckoutMessage(noise)).toBeNull();
    }
  });

  it("drops fields that aren't the right shape", () => {
    const parsed = parseCheckoutMessage({
      type: "polaris:checkout",
      version: 1,
      event: "completed",
      sessionId: "cs_test_1",
      mode: "now",
      txHash: "not-hex",
      orderId: { evil: true },
    });
    expect(parsed).toMatchObject({ result: { txHash: null, orderId: null } });
  });
});

describe("keys", () => {
  it("parses kind and mode", () => {
    expect(parseKey("pk_test_abcDEF123456")).toEqual({ kind: "publishable", mode: "test", livemode: false });
    expect(parseKey("sk_live_abcDEF123456")).toEqual({ kind: "secret", mode: "live", livemode: true });
    expect(parseKey("whsec_abc")).toBeNull();
    expect(parseKey("pk_prod_abcDEF123456")).toBeNull();
  });
});

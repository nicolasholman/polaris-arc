import { describe, expect, it } from "vitest";

// @ts-expect-error: a plain ESM script with no type declarations.
import { checkStep } from "../scripts/verify-testnet-results.mjs";

/**
 * smoke:testnet:verify reads the live run's results back from the chain. Each
 * row must have landed, have been sent by the sender it names (one of the
 * relayer, the registry admin or the harness), to the deployment's address
 * for the contract it names, carrying no MON.
 */

const RELAYER = "0x8366916019bc5452e62A0D36418ABebB45396aE2";
const HARNESS = "0x6Df4a0b84BD608123D1f3412709AcaC69523c115";
const CHECKOUT = "0x3874ef1bcE222755525a96f8284631780b9bC70B";
const STRANGER = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}`;
const ctx = { contracts: { PolarisCheckout: CHECKOUT }, senders: new Set([RELAYER, HARNESS]) };
const step = { txHash: HASH, from: RELAYER, contract: "PolarisCheckout", by: "Privy relayer", signedBy: "buyer" };
const chain = (over: { tx?: Record<string, unknown>; receipt?: Record<string, unknown> | null } = {}) => ({
  tx: { from: RELAYER, to: CHECKOUT, value: 0n, ...over.tx },
  receipt: over.receipt === null ? null : { status: "success", ...over.receipt },
});

describe("smoke:testnet:verify (checkStep)", () => {
  it("passes a relayed transaction that landed on the contract it names with no MON", () => {
    expect(checkStep(step, chain(), ctx)).toEqual([]);
  });

  it("fails a revert, a missing receipt, another sender, another target and any MON", () => {
    expect(checkStep(step, chain({ receipt: { status: "reverted" } }), ctx).join(" ")).toMatch(/status reverted/);
    expect(checkStep(step, chain({ receipt: null }), ctx)).toEqual([`${HASH}: no receipt`]);
    expect(checkStep(step, chain({ tx: { from: STRANGER } }), ctx).join(" ")).toMatch(/none of the relayer/);
    expect(checkStep(step, chain({ tx: { to: STRANGER } }), ctx).join(" ")).toMatch(/but PolarisCheckout is/);
    expect(checkStep(step, chain({ tx: { value: 1n } }), ctx).join(" ")).toMatch(/carried 1 wei/);
    expect(checkStep({ ...step, contract: "Nowhere" }, chain(), ctx).join(" ")).toMatch(/not in the deployment record/);
  });
});

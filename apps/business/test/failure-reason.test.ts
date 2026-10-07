import { encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import { failureReasonOf } from "@/server/chain/errors";

/**
 * Why a collection was skipped, from the revert CollectionsReceiver records
 * in TaskSkipped: the words the dunning, the app's "Sign again" and the
 * installment.failed webhook use. The indexer (packages/indexer
 * src/lib/revert.ts) and the collections workflow (src/collections/outcomes.ts)
 * read the same reverts the same way, a token's Error(string) included.
 */
describe("failureReasonOf", () => {
  const custom = parseAbi([
    "error InsufficientAllowance(uint256 have, uint256 need)",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error NotDue()",
  ]);
  const message = (text: string) => encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: [text] });

  it("maps the custom errors", () => {
    expect(failureReasonOf(encodeErrorResult({ abi: custom, errorName: "InsufficientAllowance", args: [0n, 1n] }))).toBe("allowance_lost");
    expect(failureReasonOf(encodeErrorResult({ abi: custom, errorName: "ERC20InsufficientBalance", args: ["0x0000000000000000000000000000000000000001", 0n, 1n] }))).toBe(
      "insufficient_funds",
    );
    expect(failureReasonOf(encodeErrorResult({ abi: custom, errorName: "NotDue" }))).toBe("stale");
  });

  it("reads a token that reverts with a message, as the indexer and the workflow do", () => {
    expect(failureReasonOf(message("ERC20: insufficient allowance"))).toBe("allowance_lost");
    expect(failureReasonOf(message("ERC20: transfer amount exceeds allowance"))).toBe("allowance_lost");
    expect(failureReasonOf(message("ERC20: transfer amount exceeds balance"))).toBe("insufficient_funds");
    expect(failureReasonOf(message("Pausable: paused"))).toBe("other");
  });

  it("anything unreadable is other", () => {
    expect(failureReasonOf("0x")).toBe("other");
    expect(failureReasonOf("0xdeadbeef")).toBe("other");
  });
});

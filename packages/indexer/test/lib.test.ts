/**
 * The pure pieces the handlers stand on: the loan engine's schedule
 * arithmetic, ScoreManager's credit line, revert decoding, cursors, and the
 * generated config staying true to the contract ABIs.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeErrorResult, getAddress, keccak256, parseAbi, sha256, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";

import { checksumAddress, keccak256Hex, sha256Hex } from "../client/src/hash.js";
import { failureReasonOf as clientFailureReason } from "../client/src/webhooks.js";

import { baseLimitOf, creditLimitOf, type CreditInputs, type CreditSettings } from "../src/lib/credit.js";
import {
  dueAt,
  installmentSlice,
  installmentsEarned,
  interestFor,
  nextAttemptAfterFailure,
  paidToward,
  thresholdFor,
} from "../src/lib/loans.js";
import { decodeRevert, ERROR_SELECTORS } from "../src/lib/revert.js";
import { cursorOf, dateOf, dayOf, failureReasonOf, monthlyValue } from "../src/lib/util.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USD = (n: number) => BigInt(Math.round(n * 1e6));
const WEEK = 7 * 86_400;

describe("loan schedule (PolarisLoanEngine mirror)", () => {
  // $200 in 4 weekly instalments: the numbers the pitch and the contract README quote.
  const principal = USD(200);
  const interest = interestFor(principal, 4, WEEK);
  const totalOwed = principal + interest;

  it("prices $200 x 4 weekly at 201534246 owed, 50383562 first instalment", () => {
    expect(interest).toBe(1_534_246n);
    expect(totalOwed).toBe(201_534_246n);
    expect(installmentSlice(totalOwed, 4, 0)).toBe(50_383_562n);
  });

  it("builds a ladder that ends exactly at totalOwed and never loses a unit", () => {
    const slices = [0, 1, 2, 3].map((i) => installmentSlice(totalOwed, 4, i));
    expect(slices.reduce((a, b) => a + b, 0n)).toBe(totalOwed);
    expect(thresholdFor(totalOwed, 4, 4)).toBe(totalOwed);
    expect(thresholdFor(totalOwed, 4, 0)).toBe(0n);
    for (const s of slices) expect(s === 50_383_562n || s === 50_383_561n).toBe(true);
  });

  it("counts instalments from money received, so dust never completes one", () => {
    expect(installmentsEarned(totalOwed, 4, 1n)).toBe(0);
    expect(installmentsEarned(totalOwed, 4, 50_383_561n)).toBe(0);
    expect(installmentsEarned(totalOwed, 4, 50_383_562n)).toBe(1);
    expect(installmentsEarned(totalOwed, 4, totalOwed - 1n)).toBe(3);
    expect(installmentsEarned(totalOwed, 4, totalOwed)).toBe(4);
  });

  it("splits a partial payment across the instalment it went toward", () => {
    expect(paidToward(totalOwed, 4, 0, 60_000_000n)).toBe(50_383_562n);
    expect(paidToward(totalOwed, 4, 1, 60_000_000n)).toBe(60_000_000n - 50_383_562n);
    expect(paidToward(totalOwed, 4, 2, 60_000_000n)).toBe(0n);
  });

  it("puts instalment i at firstDueAt + i * interval", () => {
    expect(dueAt(1_000, 60, 0)).toBe(1_000);
    expect(dueAt(1_000, 60, 3)).toBe(1_180);
  });

  it("walks the dunning ladder and never past the liquidation point", () => {
    const ladder = [21_600, 86_400, 259_200, 604_800];
    expect(nextAttemptAfterFailure(100, 1, ladder, undefined)).toBe(21_700);
    expect(nextAttemptAfterFailure(100, 2, ladder, undefined)).toBe(86_500);
    expect(nextAttemptAfterFailure(100, 9, ladder, undefined)).toBe(604_900);
    expect(nextAttemptAfterFailure(100, 1, ladder, 3_701)).toBe(3_701);
  });
});

describe("credit line (ScoreManager mirror)", () => {
  const settings: CreditSettings = { requireUnderwriting: true, collateralCountsTowardLimits: true, collateralMultiplierBps: 15_000 };
  const buyer = (over: Partial<CreditInputs>): CreditInputs => ({
    score: 600,
    hasRecord: false,
    declined: false,
    underwritten: false,
    collateral: 0n,
    ...over,
  });

  it("gives nothing unsecured before underwriting when it is required", () => {
    expect(baseLimitOf(buyer({}), settings)).toBe(0n);
    expect(baseLimitOf(buyer({}), { ...settings, requireUnderwriting: false })).toBe(USD(500));
  });

  it("maps score tiers to lines", () => {
    const at = (score: number) => baseLimitOf(buyer({ score, hasRecord: true, underwritten: true }), settings);
    expect(at(300)).toBe(USD(200));
    expect(at(580)).toBe(USD(500));
    expect(at(670)).toBe(USD(1_000));
    expect(at(739)).toBe(USD(1_000));
    expect(at(740)).toBe(USD(2_500));
    expect(at(800)).toBe(USD(5_000));
  });

  it("adds 150% of collateral, capped at the collateral itself when secured-only", () => {
    expect(creditLimitOf(buyer({ score: 700, hasRecord: true, underwritten: true, collateral: USD(100) }), settings)).toBe(USD(1_150));
    expect(creditLimitOf(buyer({ declined: true, collateral: USD(100) }), settings)).toBe(USD(100));
    expect(creditLimitOf(buyer({ underwritten: true, collateral: USD(100) }), { ...settings, collateralCountsTowardLimits: false })).toBe(USD(500));
  });
});

describe("revert decoding (CollectionsReceiver.TaskSkipped reasons)", () => {
  const abi = parseAbi([
    "error InsufficientAllowance(uint256 have, uint256 need)",
    "error InsufficientBalance(uint256 have, uint256 need)",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error WalletAlreadyLinked(address wallet, address user)",
    "error NotDue()",
  ]);

  it("knows every selector it claims to (recomputed with viem)", () => {
    for (const [selector, known] of Object.entries(ERROR_SELECTORS)) {
      expect(toFunctionSelector(known.signature), known.signature).toBe(selector);
    }
  });

  it("tells re-sign from top up, with what was had and needed", () => {
    const allowance = decodeRevert(encodeErrorResult({ abi, errorName: "InsufficientAllowance", args: [5n, 50_383_562n] }));
    expect(allowance).toMatchObject({ name: "InsufficientAllowance", action: "allowance_lost", have: 5n, need: 50_383_562n });
    const balance = decodeRevert(encodeErrorResult({ abi, errorName: "InsufficientBalance", args: [7n, 9n] }));
    expect(balance).toMatchObject({ name: "InsufficientBalance", action: "insufficient_funds", have: 7n, need: 9n });
    const token = decodeRevert(
      encodeErrorResult({ abi, errorName: "ERC20InsufficientBalance", args: ["0x00000000000000000000000000000000000000aa", 1n, 2n] }),
    );
    expect(token).toMatchObject({ name: "ERC20InsufficientBalance", action: "insufficient_funds", have: 1n, need: 2n });
  });

  it("calls a not-due candidate stale, and keeps an unknown selector raw", () => {
    expect(decodeRevert(encodeErrorResult({ abi, errorName: "NotDue" }))).toMatchObject({ name: "NotDue", action: "stale" });
    expect(decodeRevert("0xdeadbeef")).toMatchObject({ name: "0xdeadbeef", action: "other" });
    expect(decodeRevert("0x")).toMatchObject({ name: "EMPTY", action: "other" });
  });

  it("reads Error(string) and guesses allowance or balance from the message", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["ERC20: transfer amount exceeds allowance"] });
    expect(decodeRevert(data)).toMatchObject({ name: "Error", action: "allowance_lost", message: "ERC20: transfer amount exceeds allowance" });
  });

  it("returns the addresses of WalletAlreadyLinked", () => {
    const wallet = "0x00000000000000000000000000000000000000aa";
    const user = "0x00000000000000000000000000000000000000bb";
    expect(decodeRevert(encodeErrorResult({ abi, errorName: "WalletAlreadyLinked", args: [wallet, user] })).addresses).toEqual([wallet, user]);
  });
});

describe("cursors and days", () => {
  it("orders activities by block, log and slot", () => {
    expect(cursorOf(5, 2, 1) > cursorOf(5, 2, 0)).toBe(true);
    expect(cursorOf(5, 3, 0) > cursorOf(5, 2, 99)).toBe(true);
    expect(cursorOf(6, 0, 0) > cursorOf(5, 999_999, 99)).toBe(true);
    expect(() => cursorOf(1, 0, 100)).toThrow();
  });

  it("buckets by UTC day", () => {
    expect(dayOf(86_399)).toBe(0);
    expect(dayOf(86_400)).toBe(1);
    expect(dateOf(dayOf(1_790_000_000))).toBe("2026-09-21");
  });

  it("normalises a subscription to 30 days of revenue", () => {
    expect(monthlyValue(USD(9.99), 30 * 86_400)).toBe(USD(9.99));
    expect(monthlyValue(USD(1), 86_400)).toBe(USD(30));
  });
});

describe("generated config", () => {
  it("is current with the contract ABIs and the deployment record", () => {
    execFileSync(process.execPath, [join(ROOT, "scripts", "generate.mjs"), "--check"], { stdio: "pipe" });
  });

  it("indexes every event of every Polaris contract", () => {
    const config = readFileSync(join(ROOT, "config.yaml"), "utf8");
    const abiDir = join(ROOT, "..", "contracts", "abi");
    const contracts = [
      "PolarisCheckout",
      "PolarisPayments",
      "PolarisLoanEngine",
      "ScoreManager",
      "MerchantRegistry",
      "PolarisSend",
      "CollateralVault",
      "BatchSettlement",
      "CollectionsReceiver",
      "UnderwritingReceiver",
    ];
    for (const name of contracts) {
      const abi = JSON.parse(readFileSync(join(abiDir, `${name}.json`), "utf8")) as Array<{ type: string; name: string }>;
      for (const e of abi.filter((x) => x.type === "event" && x.name !== "EIP712DomainChanged")) {
        expect(config, `${name}.${e.name}`).toContain(`"${e.name}(`);
      }
    }
  });

  it("has a handler for every event config.yaml indexes", () => {
    // Envio's runtime passes over an indexed event nobody handles without a
    // word; only a replayed log of that kind would notice. Handlers name their
    // events as `event: "Name"` (some in a loop over contracts).
    const config = readFileSync(join(ROOT, "config.yaml"), "utf8");
    const indexed = new Set([...config.matchAll(/- event: "(\w+)\(/g)].map((m) => m[1]!));
    const handlers = readdirSync(join(ROOT, "src", "handlers"))
      .map((f) => readFileSync(join(ROOT, "src", "handlers", f), "utf8"))
      .join("\n");
    const handled = new Set([...handlers.matchAll(/event: "(\w+)"/g)].map((m) => m[1]!));
    expect(indexed.size).toBeGreaterThan(50);
    expect([...indexed].filter((e) => !handled.has(e))).toEqual([]);
  });
});

describe("the webhook helpers the client ships", () => {
  it("hashes exactly as viem does, over one, two and three Keccak blocks", () => {
    const lengths = [0, 1, 31, 32, 55, 56, 64, 135, 136, 137, 200, 271, 272, 273, 409, 500];
    for (const n of lengths) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect(`0x${keccak256Hex(bytes)}`, `keccak256, ${n} bytes`).toBe(keccak256(bytes));
      expect(`0x${sha256Hex(bytes)}`, `sha256, ${n} bytes`).toBe(sha256(bytes));
    }
  });

  it("checksums addresses as viem's getAddress", () => {
    for (let i = 1; i < 200; i++) {
      const address = `0x${(BigInt(i) * 0x9e3779b97f4a7c15f39cc0605cedc835n).toString(16).padStart(40, "0").slice(-40)}`;
      expect(checksumAddress(address)).toBe(getAddress(address));
    }
  });

  it("names a failed collection in polarispay-sdk's words, the same in the indexer and the client", () => {
    for (const action of ["insufficient_funds", "allowance_lost", "stale", "other"] as const) {
      expect(failureReasonOf(action)).toBe(clientFailureReason(action));
    }
    expect([failureReasonOf("insufficient_funds"), failureReasonOf("allowance_lost"), failureReasonOf("stale"), failureReasonOf("other")]).toEqual(["insufficient_funds", "allowance_lost", "other", "other"]);
  });
});

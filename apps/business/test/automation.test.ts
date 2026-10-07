import { encodeErrorResult, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { collectionsReceiverAbi, polarisCheckoutAbi, polarisLoanEngineAbi, underwritingReceiverAbi } from "@polarispay/contracts/abi";
import { GET as automationGet } from "@/app/api/automation/route";
import { GET as buyerGet } from "@/app/api/public/buyers/[address]/route";
import { GET as creditGet } from "@/app/api/public/credit/[account]/route";
import { GET as guardGet } from "@/app/api/public/credit-guard/route";
import { GET as sessionGet } from "@/app/api/public/sessions/[id]/route";
import { POST as relayRoute } from "@/app/api/relay/route";
import { describeRun } from "@/lib/data/keeper";
import { GUARD_PAUSED_MESSAGE, guardChecks, reasonsFromMask } from "@/lib/data/guard";
import { describeGuard, resetCreditGuardForTests, type GuardReads } from "@/server/keeper/guard";
import { deliveryOf, PROVENANCE_LABEL } from "@/server/keeper/provenance";
import { getDb } from "@/server/db";
import { syncChain } from "@/server/ingest/sync";
import { TYPES } from "@/server/relayer/typed-data";

import { makeLog, type LogSpec } from "./helpers/fake-chain";
import { ADDR, json, params, request, setupServer, signIn, type TestEnv } from "./helpers/env";
import { checkoutDomain, emitLikeTheContracts, inSeconds, merchantWithKeys, newSession, stablecoinDomain, type Merchant } from "./helpers/flows";

/**
 * Automation in the product: the credit guard (CreditGuard, read live, as
 * PolarisCheckout.openPlan applies it) served to the app, the hosted
 * checkout and shops; a buyer signing their approval again
 * (PolarisCheckout.reauthorize) through the relayer; and the keeper's reports
 * the chain sync records for the dashboard's Automation page and the app's
 * "Reviewed by the Polaris keeper".
 */

let env: TestEnv;
let merchant: Merchant;
const buyer = privateKeyToAccount(generatePrivateKey());

const NOW = BigInt(Math.floor(Date.now() / 1000));
const THRESHOLDS = { minFreeCash: 1_000_000_000n, maxBadDebtBps: 500, minOriginated: 10_000_000_000n };
/** The pool now, as CreditGuard reads it: $20,000 lent, so the bad-debt share applies. */
const POOL = { freeCash: 48_210_000_000n, totalOwed: 1_200_000_000n, badDebt: 0n, totalOriginated: 20_000_000_000n };
const OTHER_GUARDIAN = "0x00000000000000000000000000000000000060a2";

type Status = GuardReads["status"];
const NO_FEED = { priceReasons: 0, priceFeed: "0x0000000000000000000000000000000000000000" as `0x${string}`, price: 0n, priceUpdatedAt: 0n, minPrice: 0n, maxPriceAge: 0 };
const STATUS: Status = { paused: false, reasons: 0, poolReasons: 0, overrideMode: 0, overrideUntil: 0n, badDebtAcknowledged: 0n, pool: POOL, thresholds: THRESHOLDS, ...NO_FEED };
/** Chainlink's USDC / USD feed on Arc mainnet, as CreditGuard reads it (8 decimals). */
const USDC_USD = "0x84EA90AC252Dc437031461836DB5164219147905" as `0x${string}`;

/** Answer the guard's and the checkout's views on the fake chain. */
function guardian(over: { gate?: [boolean, number]; status?: Partial<Status>; checkoutGuardian?: string } = {}) {
  const status = { ...STATUS, ...over.status };
  env.chain.timestamp = NOW;
  env.chain.reads.creditGuardian = () => over.checkoutGuardian ?? ADDR.guardian;
  env.chain.reads.creditPaused = () => over.gate ?? [status.paused, status.reasons];
  env.chain.reads.creditStatus = () => status;
  resetCreditGuardForTests();
}

beforeEach(async () => {
  env = setupServer();
  emitLikeTheContracts(env);
  resetCreditGuardForTests();
  merchant = await merchantWithKeys({ webhook: false });
});

const guardNow = async () => (await json(await guardGet(request("GET", "/api/public/credit-guard"), params({})))).body.data;

/* ── The guard in words ─────────────────────────────────────────────────── */

describe("the credit guard", () => {
  it("names the reason bits the way CreditGuard sets them", () => {
    expect(reasonsFromMask(0)).toEqual([]);
    expect(reasonsFromMask(2 | 4)).toEqual(["low_cash", "bad_debt"]);
    expect(reasonsFromMask(0x80)).toEqual(["owner_pause"]);
    expect(reasonsFromMask(1 | 8)).toEqual(["depeg", "stale_price"]);
    expect(reasonsFromMask(0x40 | 0x10)).toEqual([]);
  });

  it("adds the USDC peg check where CreditGuard reads Chainlink's USDC / USD feed", () => {
    const chain = { contracts: { guardian: ADDR.guardian } as never };
    const at = new Date(Number(NOW) * 1000);
    const feed = { priceFeed: USDC_USD, price: 99_980_000n, priceUpdatedAt: NOW - 3600n, minPrice: 98_000_000n, maxPriceAge: 26 * 3600 };
    const reads = (status: Partial<Status>, gate = { paused: false, reasons: 0 }): GuardReads => ({ checkoutGuardian: ADDR.guardian, gate, status: { ...STATUS, ...feed, ...status } });

    const open = describeGuard(reads({}), chain, at);
    expect(open.checks.map((c) => c.key)).toEqual(["cash", "bad_debt", "peg"]);
    expect(open.checks[2]).toMatchObject({ ok: true, source: "feed", value: "$0.9998", limit: "at least $0.98, updated within 26 h" });
    expect(open.price).toMatchObject({ feed: USDC_USD, usd: "0.9998", minUsd: "0.98", maxAgeSeconds: 93_600 });

    const depeg = describeGuard(reads({ price: 97_000_000n, priceReasons: 1, reasons: 1, paused: true }, { paused: true, reasons: 1 }), chain, at);
    expect(depeg).toMatchObject({ state: "paused", reasons: ["depeg"] });
    expect(depeg.checks[2]).toMatchObject({ ok: false, value: "$0.97" });

    const stale = describeGuard(reads({ priceUpdatedAt: NOW - 30n * 3600n, priceReasons: 8, reasons: 8, paused: true }, { paused: true, reasons: 8 }), chain, at);
    expect(stale).toMatchObject({ state: "paused", reasons: ["stale_price"] });
    expect(stale.checks[2]).toMatchObject({ ok: false, value: "$0.9998, 30 h old" });

    // Without a feed (Arc testnet): the pool's two checks only.
    expect(describeGuard(reads(NO_FEED), chain, at)).toMatchObject({ price: null });
    expect(describeGuard(reads(NO_FEED), chain, at).checks).toHaveLength(2);
  });

  it("checks with CreditGuard's formula, at the edges, from the pool now", () => {
    const failing = (pool: Partial<typeof POOL> = {}, acknowledged = 0n) =>
      guardChecks({ ...POOL, ...pool }, THRESHOLDS, acknowledged)
        .filter((c) => !c.ok)
        .map((c) => c.key);
    expect(failing({})).toEqual([]);
    expect(failing({ freeCash: 1_000_000_000n })).toEqual([]);
    expect(failing({ freeCash: 999_999_999n })).toEqual(["cash"]);
    // badDebt > floor(totalOriginated * 500 / 10000): 5% of $20,000 is $1,000...
    expect(failing({ badDebt: 1_000_000_000n })).toEqual([]);
    expect(failing({ badDebt: 1_000_000_001n })).toEqual(["bad_debt"]);
    // ...only once $10,000 is lent, and only beyond what the owner acknowledged.
    expect(failing({ badDebt: 5_000_000_000n, totalOriginated: 9_999_999_999n })).toEqual([]);
    expect(failing({ badDebt: 1_500_000_000n }, 500_000_000n)).toEqual([]);
    expect(failing({ badDebt: 1_500_000_001n }, 500_000_000n)).toEqual(["bad_debt"]);
    const checks = guardChecks(POOL, THRESHOLDS);
    expect(checks[0]).toMatchObject({ value: "$48,210.00", limit: "at least $1,000.00", ok: true, source: "pool" });
    const young = guardChecks({ ...POOL, totalOriginated: 5_000_000_000n, badDebt: 5_000_000_000n }, THRESHOLDS);
    expect(young[1]).toMatchObject({ ok: true, limit: "at most 5%, from $10,000.00 lent" });
  });

  it("describes each state from one read, failing open like PolarisCheckout", () => {
    const chain = { contracts: { guardian: ADDR.guardian } as never };
    const reads = (over: Partial<GuardReads> = {}): GuardReads => ({ checkoutGuardian: ADDR.guardian, gate: { paused: false, reasons: 0 }, status: STATUS, ...over });
    const at = new Date(Number(NOW) * 1000);
    const open = describeGuard(reads(), chain, at);
    expect(open).toMatchObject({ state: "open", paused: false, message: null, ageSeconds: null });
    expect(open.pool).toMatchObject({ freeCashUnits: "48210000000", totalOriginatedUnits: "20000000000", badDebtAcknowledgedUnits: "0" });
    expect(open.thresholds).toMatchObject({ minFreeCashUnits: "1000000000", minOriginatedUnits: "10000000000" });

    const lowCash = describeGuard(reads({ gate: { paused: true, reasons: 2 }, status: { ...STATUS, paused: true, reasons: 2, poolReasons: 2, pool: { ...POOL, freeCash: 10n } } }), chain, at);
    expect(lowCash).toMatchObject({ state: "paused", paused: true, reasons: ["low_cash"], message: GUARD_PAUSED_MESSAGE });

    const forced = describeGuard(reads({ gate: { paused: true, reasons: 0x80 }, status: { ...STATUS, paused: true, reasons: 0x80, overrideMode: 2 } }), chain, at);
    expect(forced).toMatchObject({ state: "paused", reasons: ["owner_pause"], override: "pause", overrideUntil: null });
    const resumed = describeGuard(reads({ status: { ...STATUS, overrideMode: 1, overrideUntil: NOW + 600n } }), chain, at);
    expect(resumed).toMatchObject({ state: "open", override: "resume", overrideUntil: new Date(Number(NOW + 600n) * 1000).toISOString() });

    expect(describeGuard(reads({ checkoutGuardian: "0x0000000000000000000000000000000000000000" }), chain, at).state).toBe("unconfigured");
    expect(describeGuard(null, chain, at)).toMatchObject({ state: "unavailable", paused: false });
    expect(describeGuard(null, { contracts: { guardian: null } as never }, at).state).toBe("unconfigured");
  });

  it("GET /api/public/credit-guard: the gate and why, read live", async () => {
    guardian({ gate: [true, 2], status: { paused: true, reasons: 2, pool: { ...POOL, freeCash: 500_000_000n } } });
    const paused = await guardNow();
    expect(paused).toMatchObject({ state: "paused", paused: true, reasons: ["low_cash"], message: GUARD_PAUSED_MESSAGE, ageSeconds: null });
    expect(paused.pool).toMatchObject({ freeCashUnits: "500000000" });

    // A guard the chain won't answer for reads as open, as openPlan's own check does.
    env.chain.reads.creditStatus = () => {
      throw new Error("execution reverted");
    };
    resetCreditGuardForTests();
    expect(await guardNow()).toMatchObject({ state: "unavailable", paused: false });
  });

  it("a checkout asking another guard than the API's still decides paused, and says there is a mismatch", async () => {
    const chain = { contracts: { guardian: ADDR.guardian } as never };
    const at = new Date(Number(NOW) * 1000);
    const gateOnly = (paused: boolean, reasons: number) => ({ checkoutGuardian: OTHER_GUARDIAN as `0x${string}`, gate: { paused, reasons } });
    const paused = describeGuard(gateOnly(true, 2), chain, at);
    expect(paused).toMatchObject({ state: "paused", paused: true, reasons: ["low_cash"], message: GUARD_PAUSED_MESSAGE });
    expect(paused.mismatch).toEqual({ checkoutGuardian: OTHER_GUARDIAN, configuredGuardian: ADDR.guardian });

    guardian({ checkoutGuardian: OTHER_GUARDIAN, gate: [true, 2] });
    expect(await guardNow()).toMatchObject({ state: "paused", paused: true, reasons: ["low_cash"] });
    const session = await newSession(merchant);
    const view = (await json(await sessionGet(request("GET", `/api/public/sessions/${session.id}`), params({ id: session.id })))).body.data;
    expect(view.payIn4).toMatchObject({ available: false, reason: GUARD_PAUSED_MESSAGE });
  });

  it("the hosted checkout offers Pay in 4 as paused, with the guard's words", async () => {
    const session = await newSession(merchant);
    const view = async () => (await json(await sessionGet(request("GET", `/api/public/sessions/${session.id}`), params({ id: session.id })))).body.data;
    guardian({ gate: [true, 2], status: { paused: true, reasons: 2 } });
    expect((await view()).payIn4).toMatchObject({ available: false, reason: GUARD_PAUSED_MESSAGE, guard: { state: "paused", paused: true } });
    guardian();
    expect((await view()).payIn4).toMatchObject({ available: true, reason: null, guard: { state: "open", paused: false } });
  });
});

/* ── Signing again: PolarisCheckout.reauthorize ─────────────────────────── */

async function signPermit(value: bigint, nonce = 0n, spender = ADDR.loanEngine, signer = buyer) {
  const deadline = BigInt(inSeconds(900));
  const signature = await signer.signTypedData({
    domain: stablecoinDomain,
    types: TYPES.Permit,
    primaryType: "Permit",
    message: { owner: buyer.address, spender, value, nonce, deadline },
  });
  return { value: value.toString(), deadline: deadline.toString(), signature };
}

const reauthorize = (permit: unknown) => relayRoute(request("POST", "/api/relay", { body: { type: "reauthorize", buyer: buyer.address, permit } }), params({}));

describe("signing again for a lost approval", () => {
  beforeEach(() => {
    env.chain.reads.activeDebtOf = () => 151_150_684n;
    env.chain.reads.allowance = () => 0n;
    env.chain.reads.nonces = () => 0n;
  });

  it("relays the buyer's permit to PolarisCheckout.reauthorize, once", async () => {
    const permit = await signPermit(151_150_684n);
    const res = await json(await reauthorize(permit));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: "reauthorize", status: "confirmed" });
    const [sent] = env.chain.relayed;
    expect(sent).toMatchObject({ to: ADDR.checkout, functionName: "reauthorize" });
    expect(sent?.args[0]).toBe(buyer.address);
    expect((sent?.args[1] as { value: bigint }).value).toBe(151_150_684n);

    // The same signature again is the same transaction, not a second one.
    const again = await json(await reauthorize(permit));
    expect(again.body.data.txHash).toBe(res.body.data.txHash);
    expect(env.chain.relayed).toHaveLength(1);
  });

  it("refuses before any gas: nothing owed, approval already enough, a permit short of the debt, someone else's signature", async () => {
    env.chain.reads.activeDebtOf = () => 0n;
    expect((await json(await reauthorize(await signPermit(1n)))).body.error.code).toBe("nothing_owed");

    env.chain.reads.activeDebtOf = () => 151_150_684n;
    env.chain.reads.allowance = () => 200_000_000n;
    expect((await json(await reauthorize(await signPermit(151_150_684n)))).body.error.code).toBe("already_authorised");

    env.chain.reads.allowance = () => 0n;
    const short = await json(await reauthorize(await signPermit(151_150_683n)));
    expect(short.status).toBe(409);
    expect(short.body.error.param).toBe("permit.value");

    const stranger = privateKeyToAccount(generatePrivateKey());
    const forged = await json(await reauthorize(await signPermit(151_150_684n, 0n, ADDR.loanEngine, stranger)));
    expect(forged.body.error.code).toBe("invalid_signature");

    const wrongSpender = await json(await reauthorize(await signPermit(151_150_684n, 0n, ADDR.checkout)));
    expect(wrongSpender.body.error.code).toBe("invalid_signature");
    expect(env.chain.relayed).toHaveLength(0);
  });
});

/* ── What the keeper reports did, from the chain ───────────────────────────── */

function chainEmits(specs: LogSpec[]): Hex {
  env.chain.blockNumber += 1n;
  const txHash = `0x${env.chain.blockNumber.toString(16).padStart(64, "0")}` as Hex;
  env.chain.logs.push(...specs.map((s, i) => makeLog(s, { txHash, logIndex: i, blockNumber: env.chain.blockNumber })));
  return txHash;
}

async function openPlan(): Promise<void> {
  const session = await newSession(merchant);
  const deadline = BigInt(inSeconds(600));
  const intent = { buyer: buyer.address, merchant: merchant.account.address, principal: 200_000_000n, installments: 4, interval: 604_800n, orderId: session.orderId as string, nonce: 0n, deadline };
  const signature = await buyer.signTypedData({ domain: checkoutDomain, types: TYPES.PlanIntent, primaryType: "PlanIntent", message: intent });
  const res = await relayRoute(
    request("POST", "/api/relay", {
      body: { type: "openPlan", sessionId: session.id, intent: { buyer: buyer.address, principal: "200000000", installments: "4", interval: "604800", nonce: "0", deadline: String(deadline) }, signature },
    }),
    params({}),
  );
  expect(res.status).toBe(200);
}

const collections = { address: ADDR.collections, abi: collectionsReceiverAbi as never };
const engine = { address: ADDR.loanEngine, abi: polarisLoanEngineAbi as never };
const book = async () => (await json(await buyerGet(request("GET", `/api/public/buyers/${buyer.address}`), params({ address: buyer.address })))).body.data;
const automation = async () => {
  signIn({ userId: merchant.userId, walletAddress: merchant.account.address, walletId: `wal_${merchant.account.address.slice(2, 10)}` });
  return (await json(await automationGet(request("GET", "/api/automation"), params({})))).body.data;
};

describe("the chain sync records what each keeper report did", () => {
  it("a lost approval: dunned, the buyer signs again, the next collections run collects, and the page links the two", async () => {
    guardian();
    await syncChain();
    await openPlan();

    // A collections run can't collect: the loan engine's allowance is gone.
    const lost = encodeErrorResult({ abi: polarisLoanEngineAbi, errorName: "InsufficientAllowance", args: [0n, 50_383_562n] });
    chainEmits([
      { ...collections, eventName: "TaskSkipped", args: { action: 1, id: 1n, reason: lost } },
      { ...collections, eventName: "CollectionsRun", args: { tasks: 1n, executed: 0n, skipped: 1n } },
    ]);
    await syncChain();
    const dunned = (await book()).plans[0];
    expect(dunned).toMatchObject({ state: "dunning", needsSignature: true, reauthorized: null, lastFailure: { reason: "allowance_lost" } });

    // The buyer signs again: Reauthorized.
    const signedAt = env.chain.timestamp;
    const reauthorizedTx = chainEmits([{ address: ADDR.checkout, abi: polarisCheckoutAbi as never, eventName: "Reauthorized", args: { buyer: buyer.address, value: 151_150_684n, deadline: signedAt + 900n } }]);
    await syncChain();
    const signed = (await book()).plans[0];
    expect(signed).toMatchObject({ needsSignature: false, reauthorized: { txHash: reauthorizedTx, collected: null } });

    // Seven seconds later the keeper's instant retry collects the instalment.
    env.chain.timestamp = signedAt + 7n;
    const collectedTx = chainEmits([
      { ...engine, eventName: "InstallmentPaid", args: { loanId: 1n, borrower: buyer.address, installmentIndex: 0, amount: 50_383_562n, onTime: false } },
      { ...collections, eventName: "TaskExecuted", args: { action: 1, id: 1n, amount: 50_383_562n } },
      { ...collections, eventName: "CollectionsRun", args: { tasks: 1n, executed: 1n, skipped: 0n } },
    ]);
    await syncChain();
    const collected = (await book()).plans[0];
    expect(collected).toMatchObject({ state: "collecting", installmentsPaid: 1, needsSignature: false, reauthorized: { txHash: reauthorizedTx, collected: { txHash: collectedTx } } });

    const page = await automation();
    expect(page.deployed).toBe(true);
    expect(page.keeper).toMatchObject({ address: "0x000000000000000000000000000000000000bEEF" });
    const flow = page.workflows.find((w: { key: string }) => w.key === "collections");
    expect(flow.triggers.map((t: { kind: string }) => t.kind)).toEqual(["timer", "evm-log"]);
    expect(flow.runs).toHaveLength(2);
    const [latest, first] = flow.runs;
    expect(latest).toMatchObject({ txHash: collectedTx, collections: { collected: 1, collectedUnits: "50383562", yours: { collected: 1 }, afterReauthorization: { txHash: reauthorizedTx, seconds: 7, yours: true } } });
    expect(first.collections).toMatchObject({ collected: 0, skippedBy: { allowance_lost: 1 }, yours: { dunned: 1 } });
    expect(describeRun("collections", latest).detail).toContain("Instant retry: 7 s after the buyer signed again");
  });

  it("underwriting reports, with the account's provenance", async () => {
    guardian();
    await syncChain();
    const uwTx = chainEmits([
      { address: ADDR.underwriting, abi: underwritingReceiverAbi as never, eventName: "UnderwritingApplied", args: { user: buyer.address, linkedWallet: "0x0000000000000000000000000000000000000000", score: 712 } },
    ]);
    await syncChain();

    const page = await automation();
    expect(page.workflows.map((w: { key: string }) => w.key)).toEqual(["collections", "underwrite"]);
    const uw = page.workflows.find((w: { key: string }) => w.key === "underwrite");
    // Not one of this merchant's buyers: the score, but not the account.
    expect(uw.runs[0]).toMatchObject({ txHash: uwTx, underwrite: { applied: 1, items: [{ applied: true, score: 712, buyer: null }] } });
    expect(describeRun("underwrite", uw.runs[0]).title).toBe("1 credit line opened");

    env.chain.reads.profileOf = () => ({ score: 712, onTimePayments: 0, latePayments: 0, liquidations: 0, firstSeenAt: 0n, initialized: true, declined: false, underwritten: true });
    env.chain.reads.creditLimitOf = () => 500_000_000n;
    env.chain.reads.activeDebtOf = () => 0n;
    const credit = (await json(await creditGet(request("GET", `/api/public/credit/${buyer.address}`), params({ account: buyer.address })))).body.data;
    expect(credit.decision).toMatchObject({ status: "applied", txHash: uwTx, verified: { by: "Polaris keeper", txHash: uwTx } });
    expect(credit.decision.verified.at).toBe(new Date(Number(env.chain.timestamp) * 1000).toISOString());
    // A local chain's report says so.
    expect(credit.decision.verified).toMatchObject({ delivery: "local", label: "Reviewed by the Polaris keeper (local chain)" });
    expect(await getDb().creRuns.count({})).toBe(1);
  });
});

/* ── Nothing deployed ───────────────────────────────────────────────── */

describe("the Automation page with nothing deployed", () => {
  it("says nothing is deployed, with no jobs, runs or hashes to show", async () => {
    setupServer({ POLARIS_DEPLOYMENT_FILE: "does-not-exist.json", RELAYER_MODE: "off" });
    signIn({ userId: "did:privy:undeployed", walletAddress: "0x2222222222222222222222222222222222222222" });
    const res = await json(await automationGet(request("GET", "/api/automation"), params({})));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deployed: false, network: null, workflows: [], guard: { state: "unconfigured", checks: [] } });
    expect(JSON.stringify(res.body.data)).not.toMatch(/0x[0-9a-f]{64}/i);
  });
});

/* ── Who stands behind a keeper report ─────────────────────────────────── */

describe("report provenance (the app's \"Reviewed by the Polaris keeper\")", () => {
  const keeper = "0x000000000000000000000000000000000000bEEF";
  const testnet = { id: 5042002, rpcUrl: "https://rpc.testnet.arc.io", keeper: { address: keeper as `0x${string}` } };

  it("is the keeper's only when the report came from the keeper the record names; a local chain says what it is", () => {
    expect(deliveryOf(keeper, testnet)).toBe("keeper");
    expect(deliveryOf(keeper.toLowerCase(), testnet)).toBe("keeper");
    expect(deliveryOf("0x00000000000000000000000000000000000f0a3d", testnet)).toBe("unknown");
    expect(deliveryOf(null, testnet)).toBe("unknown");
    expect(deliveryOf(keeper, { ...testnet, id: 31337, rpcUrl: "http://127.0.0.1:8600" })).toBe("local");
    expect(PROVENANCE_LABEL).toEqual({
      keeper: "Reviewed by the Polaris keeper",
      local: "Reviewed by the Polaris keeper (local chain)",
      unknown: "Polaris keeper report",
    });
  });
});

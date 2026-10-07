import { encodeErrorResult, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  collectionsReceiverAbi,
  guardianReceiverAbi,
  polarisCheckoutAbi,
  polarisLoanEngineAbi,
  underwritingReceiverAbi,
} from "@polarispay/contracts/abi";
import { GET as chainlinkGet } from "@/app/api/chainlink/route";
import { GET as buyerGet } from "@/app/api/public/buyers/[address]/route";
import { GET as creditGet } from "@/app/api/public/credit/[account]/route";
import { GET as guardGet } from "@/app/api/public/credit-guard/route";
import { GET as sessionGet } from "@/app/api/public/sessions/[id]/route";
import { POST as relayRoute } from "@/app/api/relay/route";
import { describeRun } from "@/lib/data/chainlink";
import { describeCron, nextCronFire } from "@/lib/data/cron";
import { GUARD_PAUSED_MESSAGE, guardChecks, lastCheckedLine, reasonsFromMask } from "@/lib/data/guard";
import { describeGuard, resetCreditGuardForTests, type GuardReads } from "@/server/cre/guardian";
import { CHAINLINK_FORWARDERS, deliveryOf, forwarderKindOf, PROVENANCE_LABEL, resetProvenanceForTests } from "@/server/cre/provenance";
import { deliveryLabel } from "@/lib/data/chainlink";
import { getDb } from "@/server/db";
import { syncChain } from "@/server/ingest/sync";
import { TYPES } from "@/server/relayer/typed-data";

import { makeLog, type LogSpec } from "./helpers/fake-chain";
import { ADDR, json, params, request, setupServer, signIn, type TestEnv } from "./helpers/env";
import { checkoutDomain, emitLikeTheContracts, inSeconds, merchantWithKeys, newSession, stablecoinDomain, type Merchant } from "./helpers/flows";

/**
 * The Chainlink features in the product: the credit guard (the CRE guardian's
 * verdict, as PolarisCheckout.openPlan applies it) served to the app, the
 * hosted checkout and shops; a buyer signing their approval again
 * (PolarisCheckout.reauthorize) through the relayer; and the CRE reports the
 * chain sync records for the dashboard's Chainlink page and the app's
 * "Verified by Chainlink CRE".
 */

let env: TestEnv;
let merchant: Merchant;
const buyer = privateKeyToAccount(generatePrivateKey());

const NOW = BigInt(Math.floor(Date.now() / 1000));
const THRESHOLDS = { minPrice: 99_500_000n, maxPrice: 100_500_000n, minFreeCash: 1_000_000_000n, maxBadDebtBps: 500, minOriginated: 10_000_000_000n, maxPriceAge: 7200 };
/** The pool now, as GuardianReceiver reads it: $20,000 lent, so the bad-debt share applies. */
const POOL = { freeCash: 48_210_000_000n, totalOwed: 1_200_000_000n, badDebt: 0n, totalOriginated: 20_000_000_000n };
const OTHER_GUARDIAN = "0x00000000000000000000000000000000000060a2";
const HEALTHY = {
  priceRoundId: 18446744073709552000n,
  price: 99_980_000n,
  priceUpdatedAt: NOW - 600n,
  freeCash: 48_210_000_000n,
  totalOwed: 1_200_000_000n,
  badDebt: 0n,
  totalOriginated: 5_000_000_000n,
  observedAt: NOW - 120n,
  creditPaused: false,
  reasons: 0,
};

type GuardOver = {
  gate?: [boolean, number];
  status?: Partial<{
    paused: boolean;
    reasons: number;
    attestedPaused: boolean;
    attestedReasons: number;
    observedAt: bigint;
    stale: boolean;
    overrideMode: number;
    maxAttestationAge: number;
    round: bigint;
    overrideUntil: bigint;
    poolReasons: number;
    priceReasons: number;
    badDebtAcknowledged: bigint;
  }>;
  latest?: Partial<typeof HEALTHY>;
  pool?: Partial<typeof POOL>;
  checkoutGuardian?: string;
};

/** Answer the guardian's and the checkout's views on the fake chain. */
function guardian(over: GuardOver = {}) {
  const latest = { ...HEALTHY, ...over.latest };
  const status = {
    paused: false,
    reasons: 0,
    attestedPaused: latest.creditPaused,
    attestedReasons: latest.reasons,
    observedAt: latest.observedAt,
    stale: false,
    overrideMode: 0,
    maxAttestationAge: 3600,
    round: 3n,
    overrideUntil: 0n,
    poolReasons: 0,
    priceReasons: latest.reasons & 9,
    badDebtAcknowledged: 0n,
    ...over.status,
  };
  env.chain.timestamp = NOW;
  env.chain.reads.creditGuardian = () => over.checkoutGuardian ?? ADDR.guardian;
  env.chain.reads.creditPaused = () => over.gate ?? [status.paused, status.reasons];
  env.chain.reads.creditStatus = () => status;
  env.chain.reads.currentInputs = () => [{ ...POOL, ...over.pool }, THRESHOLDS, status.badDebtAcknowledged];
  env.chain.reads.latestAttestation = () => latest;
  env.chain.reads.latestRoundData = () => [3n, 4_820_000_000_000n, latest.observedAt, latest.observedAt, 3n];
  env.chain.reads.decimals = () => 8;
  env.chain.reads.description = () => "Polaris pool health, computed by CRE";
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
  it("names the reason bits the way GuardianReceiver sets them", () => {
    expect(reasonsFromMask(0)).toEqual([]);
    expect(reasonsFromMask(1 | 4)).toEqual(["depeg", "bad_debt"]);
    expect(reasonsFromMask(0x80)).toEqual(["owner_pause"]);
    expect(reasonsFromMask(2 | 8 | 0x40)).toEqual(["low_cash", "stale_price"]);
  });

  it("checks with GuardianReceiver's formula, at the edges: the price from the attestation, the cash and bad debt from the pool now", () => {
    const failing = (a: Partial<typeof HEALTHY>, pool: Partial<typeof POOL> = {}, acknowledged = 0n) =>
      guardChecks({ ...HEALTHY, ...a }, { ...POOL, ...pool }, THRESHOLDS, acknowledged)
        .filter((c) => !c.ok)
        .map((c) => c.key);
    expect(failing({})).toEqual([]);
    // price < minPrice or > maxPrice: $0.995 and $1.005 exactly are not a depeg, one unit past either is.
    expect(failing({ price: 99_500_000n })).toEqual([]);
    expect(failing({ price: 99_499_999n })).toEqual(["price"]);
    expect(failing({ price: 100_500_000n })).toEqual([]);
    expect(failing({ price: 100_500_001n })).toEqual(["price"]);
    // freeCash < minFreeCash, in the pool now: the attestation's figure no longer decides.
    expect(failing({}, { freeCash: 1_000_000_000n })).toEqual([]);
    expect(failing({}, { freeCash: 999_999_999n })).toEqual(["cash"]);
    expect(failing({ freeCash: 0n })).toEqual([]);
    // badDebt > floor(totalOriginated * 500 / 10000): 5% of $20,000 is $1,000...
    expect(failing({}, { badDebt: 1_000_000_000n })).toEqual([]);
    expect(failing({}, { badDebt: 1_000_000_001n })).toEqual(["bad_debt"]);
    // ...only once $10,000 is lent, and only beyond what the owner acknowledged.
    expect(failing({}, { badDebt: 5_000_000_000n, totalOriginated: 9_999_999_999n })).toEqual([]);
    expect(failing({}, { badDebt: 1_500_000_000n }, 500_000_000n)).toEqual([]);
    expect(failing({}, { badDebt: 1_500_000_001n }, 500_000_000n)).toEqual(["bad_debt"]);
    // priceUpdatedAt == 0, or observedAt - priceUpdatedAt > maxPriceAge.
    expect(failing({ priceUpdatedAt: 0n })).toEqual(["price_age"]);
    expect(failing({ priceUpdatedAt: HEALTHY.observedAt - 7200n })).toEqual([]);
    expect(failing({ priceUpdatedAt: HEALTHY.observedAt - 7201n })).toEqual(["price_age"]);
    // A price stamped after the observation is not stale (the contract's observedAt > priceUpdatedAt guard).
    expect(failing({ priceUpdatedAt: HEALTHY.observedAt + 30n })).toEqual([]);
    const checks = guardChecks({ ...HEALTHY, price: 99_000_000n }, POOL, THRESHOLDS);
    expect(checks[0]).toMatchObject({ label: "AUSD/USD", value: "$0.9900", limit: "between $0.995 and $1.005", ok: false, source: "attestation" });
    expect(checks[1]).toMatchObject({ value: "$48,210.00", limit: "at least $1,000.00", ok: true, source: "pool" });
    expect(checks.map((c) => c.source)).toEqual(["attestation", "pool", "pool", "attestation"]);
    // No attestation yet: only the pool's checks, which apply all the same.
    expect(guardChecks(null, POOL, THRESHOLDS).map((c) => c.key)).toEqual(["cash", "bad_debt"]);
    const young = guardChecks(null, { ...POOL, totalOriginated: 5_000_000_000n, badDebt: 5_000_000_000n }, THRESHOLDS);
    expect(young[1]).toMatchObject({ ok: true, limit: "at most 5%, from $10,000.00 lent" });
  });

  it("describes each state from one read, failing open like PolarisCheckout", () => {
    const chain = { contracts: { guardian: ADDR.guardian } as never, cre: null };
    const reads = (over: Partial<GuardReads> = {}): GuardReads => ({
      checkoutGuardian: ADDR.guardian,
      gate: { paused: false, reasons: 0 },
      status: {
        paused: false,
        reasons: 0,
        attestedPaused: false,
        attestedReasons: 0,
        observedAt: NOW - 120n,
        stale: false,
        overrideMode: 0,
        maxAttestationAge: 3600,
        round: 3n,
        overrideUntil: 0n,
        poolReasons: 0,
        priceReasons: 0,
        badDebtAcknowledged: 0n,
      },
      pool: POOL,
      thresholds: THRESHOLDS,
      badDebtAcknowledged: 0n,
      latest: HEALTHY,
      round: { roundId: 3n, answer: 4_820_000_000_000n, updatedAt: NOW - 120n },
      feedDecimals: 8,
      feedDescription: "Polaris pool health, computed by CRE",
      blockTimestamp: NOW,
      ...over,
    });
    const at = new Date(Number(NOW) * 1000);
    const open = describeGuard(reads(), chain, at);
    expect(open).toMatchObject({ state: "open", paused: false, message: null, ageSeconds: 120, round: 3 });
    expect(open.feed).toMatchObject({ description: "Polaris pool health, computed by CRE", answerUsd: "48,200.00", decimals: 8 });

    const paused = describeGuard(reads({ gate: { paused: true, reasons: 1 }, status: { ...reads().status, paused: true, reasons: 1, attestedPaused: true, attestedReasons: 1 } }), chain, at);
    expect(paused).toMatchObject({ state: "paused", paused: true, reasons: ["depeg"], message: GUARD_PAUSED_MESSAGE });

    const stale = describeGuard(reads({ status: { ...reads().status, observedAt: NOW - 5400n, stale: true } }), chain, at);
    expect(stale).toMatchObject({ state: "stale", paused: false, message: null, ageSeconds: 5400 });
    expect(lastCheckedLine(stale, Number(NOW) * 1000)).toBe("Last checked 1 h ago");

    const never = describeGuard(reads({ status: { ...reads().status, observedAt: 0n, stale: true } }), chain, at);
    expect(never).toMatchObject({ state: "never", paused: false, checkedAt: null, attestation: null });
    // No price check yet, but the pool's own checks, which GuardianReceiver reads live.
    expect(never.checks.map((c) => c.key)).toEqual(["cash", "bad_debt"]);
    expect(never.pool).toMatchObject({ freeCashUnits: "48210000000", totalOriginatedUnits: "20000000000", badDebtAcknowledgedUnits: "0" });
    expect(never.thresholds).toMatchObject({ minPrice: "0.995", maxPrice: "1.005", minOriginatedUnits: "10000000000" });

    // Low cash pauses from the pool alone, with no attestation at all.
    const lowCash = describeGuard(
      reads({ gate: { paused: true, reasons: 2 }, pool: { ...POOL, freeCash: 10n }, status: { ...reads().status, observedAt: 0n, stale: true, paused: true, reasons: 2, poolReasons: 2 } }),
      chain,
      at,
    );
    expect(lowCash).toMatchObject({ state: "paused", paused: true, reasons: ["low_cash"], sources: { pool: ["low_cash"], price: [] } });

    // The owner forced a pause: the gate says so whatever the attestation says.
    const forced = describeGuard(reads({ gate: { paused: true, reasons: 0x80 }, status: { ...reads().status, paused: true, reasons: 0x80, overrideMode: 2 } }), chain, at);
    expect(forced).toMatchObject({ state: "paused", reasons: ["owner_pause"], override: "pause", overrideUntil: null });
    // A forced resume says when it ends by itself.
    const resumed = describeGuard(reads({ status: { ...reads().status, overrideMode: 1, overrideUntil: NOW + 600n } }), chain, at);
    expect(resumed).toMatchObject({ state: "open", override: "resume", overrideUntil: new Date(Number(NOW + 600n) * 1000).toISOString() });

    // A checkout that asks no guardian, and a chain that couldn't be read.
    expect(describeGuard(reads({ checkoutGuardian: "0x0000000000000000000000000000000000000000" }), chain, at).state).toBe("unconfigured");
    expect(describeGuard(null, chain, at)).toMatchObject({ state: "unavailable", paused: false });
    expect(describeGuard(null, { contracts: { guardian: null } as never, cre: null }, at).state).toBe("unconfigured");
  });

  it("GET /api/public/credit-guard: the gate, why, and when the guard last checked", async () => {
    guardian({ gate: [true, 1], status: { paused: true, reasons: 1 }, latest: { price: 99_000_000n, creditPaused: true, reasons: 1 } });
    const paused = await guardNow();
    expect(paused).toMatchObject({ state: "paused", paused: true, reasons: ["depeg"], message: GUARD_PAUSED_MESSAGE, maxAgeSeconds: 3600 });
    expect(paused.attestation).toMatchObject({ price: "0.9900", freeCashUnits: "48210000000" });
    expect(paused.priceFeed).toMatchObject({ chainId: 143, address: "0xE20751C7B5867bCBef815ffc1b284c3f412a9e13", kind: "chainlink" });

    guardian({ status: { observedAt: NOW - 5400n, stale: true } });
    expect(await guardNow()).toMatchObject({ state: "stale", paused: false, ageSeconds: 5400 });

    // A guard the chain won't answer for reads as open, as openPlan's own check does.
    env.chain.reads.creditStatus = () => {
      throw new Error("execution reverted");
    };
    resetCreditGuardForTests();
    expect(await guardNow()).toMatchObject({ state: "unavailable", paused: false });
  });

  // Security review: on a guardian mismatch (a redeploy the API's env hasn't
  // caught up with) describeGuard returned the empty "unconfigured" guard,
  // paused: false, even while the checkout's own creditPaused() refused Pay in 4.
  it("a checkout asking another guardian than the API's still decides paused, and says there is a mismatch", async () => {
    const chain = { contracts: { guardian: ADDR.guardian } as never, cre: null };
    const at = new Date(Number(NOW) * 1000);
    const gateOnly = (paused: boolean, reasons: number) => ({ checkoutGuardian: OTHER_GUARDIAN as `0x${string}`, gate: { paused, reasons } });
    const paused = describeGuard(gateOnly(true, 1), chain, at);
    expect(paused).toMatchObject({ state: "paused", paused: true, reasons: ["depeg"], message: GUARD_PAUSED_MESSAGE });
    expect(paused.mismatch).toEqual({ checkoutGuardian: OTHER_GUARDIAN, configuredGuardian: ADDR.guardian });
    expect(describeGuard(gateOnly(false, 0), chain, at)).toMatchObject({ paused: false, mismatch: { checkoutGuardian: OTHER_GUARDIAN } });

    // Served that way to the app, the hosted checkout and shops.
    guardian({ checkoutGuardian: OTHER_GUARDIAN, gate: [true, 1] });
    expect(await guardNow()).toMatchObject({ state: "paused", paused: true, reasons: ["depeg"] });
    const session = await newSession(merchant);
    const view = (await json(await sessionGet(request("GET", `/api/public/sessions/${session.id}`), params({ id: session.id })))).body.data;
    expect(view.payIn4).toMatchObject({ available: false, reason: GUARD_PAUSED_MESSAGE });
  });

  it("the hosted checkout offers Pay in 4 as paused, with the guard's words, and keeps it on when the guard is stale", async () => {
    const session = await newSession(merchant);
    const view = async () => (await json(await sessionGet(request("GET", `/api/public/sessions/${session.id}`), params({ id: session.id })))).body.data;

    guardian({ gate: [true, 2], status: { paused: true, reasons: 2 } });
    const paused = await view();
    expect(paused.payIn4).toMatchObject({ available: false, reason: GUARD_PAUSED_MESSAGE, guard: { state: "paused", paused: true } });

    guardian({ status: { observedAt: NOW - 4000n, stale: true } });
    const stale = await view();
    expect(stale.payIn4).toMatchObject({ available: true, reason: null, guard: { state: "stale", paused: false, ageSeconds: 4000 } });
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

/* ── What the CRE reports did, from the chain ───────────────────────────── */

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
const chainlink = async () => {
  signIn({ userId: merchant.userId, walletAddress: merchant.account.address, walletId: `wal_${merchant.account.address.slice(2, 10)}` });
  return (await json(await chainlinkGet(request("GET", "/api/chainlink"), params({})))).body.data;
};

describe("the chain sync records what each CRE report did", () => {
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

    // Seven seconds later the collections workflow (its EVM log trigger) collects the instalment.
    env.chain.timestamp = signedAt + 7n;
    const collectedTx = chainEmits([
      { ...engine, eventName: "InstallmentPaid", args: { loanId: 1n, borrower: buyer.address, installmentIndex: 0, amount: 50_383_562n, onTime: false } },
      { ...collections, eventName: "TaskExecuted", args: { action: 1, id: 1n, amount: 50_383_562n } },
      { ...collections, eventName: "CollectionsRun", args: { tasks: 1n, executed: 1n, skipped: 0n } },
    ]);
    await syncChain();
    const collected = (await book()).plans[0];
    expect(collected).toMatchObject({ state: "collecting", installmentsPaid: 1, needsSignature: false, reauthorized: { txHash: reauthorizedTx, collected: { txHash: collectedTx } } });

    const page = await chainlink();
    expect(page.deployed).toBe(true);
    expect(page.delivery).toMatchObject({ forwarderKind: "local" });
    const flow = page.workflows.find((w: { key: string }) => w.key === "collections");
    expect(flow.triggers.map((t: { kind: string }) => t.kind)).toEqual(["cron", "evm-log"]);
    expect(flow.runs).toHaveLength(2);
    const [latest, first] = flow.runs;
    expect(latest).toMatchObject({ txHash: collectedTx, collections: { collected: 1, collectedUnits: "50383562", yours: { collected: 1 }, afterReauthorization: { txHash: reauthorizedTx, seconds: 7, yours: true } } });
    expect(first.collections).toMatchObject({ collected: 0, skippedBy: { allowance_lost: 1 }, yours: { dunned: 1 } });
    expect(describeRun("collections", latest).detail).toContain("Instant retry: 7 s after the buyer signed again");
  });

  it("guardian attestations and underwriting reports, with the account's provenance", async () => {
    guardian();
    await syncChain();
    const attestation = { ...HEALTHY, price: 99_000_000n, creditPaused: true, reasons: 1 };
    const guardTx = chainEmits([
      { address: ADDR.guardian, abi: guardianReceiverAbi as never, eventName: "CreditGuardUpdated", args: { round: 4n, creditPaused: true, reasons: 1, attestation } },
    ]);
    const mismatch = encodeErrorResult({ abi: guardianReceiverAbi, errorName: "VerdictMismatch", args: [false, 0, 1] });
    chainEmits([{ address: ADDR.guardian, abi: guardianReceiverAbi as never, eventName: "AttestationRefused", args: { observedAt: NOW, reason: mismatch } }]);
    const uwTx = chainEmits([
      { address: ADDR.underwriting, abi: underwritingReceiverAbi as never, eventName: "UnderwritingApplied", args: { user: buyer.address, linkedWallet: "0x0000000000000000000000000000000000000000", score: 712 } },
    ]);
    await syncChain();

    const page = await chainlink();
    const g = page.workflows.find((w: { key: string }) => w.key === "guardian");
    expect(g.runs.map((r: { guardian: { accepted: boolean } }) => r.guardian.accepted)).toEqual([false, true]);
    expect(g.runs[1]).toMatchObject({ txHash: guardTx, guardian: { round: 4, creditPaused: true, reasons: ["depeg"], price: "0.9900" } });
    expect(g.runs[0].guardian.refusal).toBe("VerdictMismatch");
    expect(describeRun("guardian", g.runs[1]).title).toBe("Pay in 4 paused");
    const uw = page.workflows.find((w: { key: string }) => w.key === "underwrite");
    // Not one of this merchant's buyers: the score, but not the account.
    expect(uw.runs[0]).toMatchObject({ txHash: uwTx, underwrite: { applied: 1, items: [{ applied: true, score: 712, buyer: null }] } });

    env.chain.reads.profileOf = () => ({ score: 712, onTimePayments: 0, latePayments: 0, liquidations: 0, firstSeenAt: 0n, initialized: true, declined: false, underwritten: true });
    env.chain.reads.creditLimitOf = () => 500_000_000n;
    env.chain.reads.activeDebtOf = () => 0n;
    const credit = (await json(await creditGet(request("GET", `/api/public/credit/${buyer.address}`), params({ account: buyer.address })))).body.data;
    expect(credit.decision).toMatchObject({ status: "applied", txHash: uwTx, verified: { by: "Chainlink CRE", workflow: "polaris-underwrite", txHash: uwTx } });
    expect(credit.decision.verified.at).toBe(new Date(Number(env.chain.timestamp) * 1000).toISOString());
    // A local chain's report is a local run, never "Verified by Chainlink CRE".
    expect(credit.decision.verified).toMatchObject({ delivery: "local", label: "CRE workflow, local run" });
    expect(await getDb().creRuns.count({})).toBe(3);
  });
});

/* ── Nothing deployed ───────────────────────────────────────────────── */

describe("the Chainlink page with nothing deployed", () => {
  it("says nothing is deployed, with no workflows, runs or hashes to show", async () => {
    setupServer({ POLARIS_DEPLOYMENT_FILE: "does-not-exist.json", RELAYER_MODE: "off" });
    signIn({ userId: "did:privy:undeployed", walletAddress: "0x2222222222222222222222222222222222222222" });
    const res = await json(await chainlinkGet(request("GET", "/api/chainlink"), params({})));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deployed: false, network: null, workflows: [], guard: { state: "unconfigured", checks: [] } });
    expect(res.body.data).not.toHaveProperty("sample");
    expect(JSON.stringify(res.body.data)).not.toMatch(/0x[0-9a-f]{64}/i);
  });
});

/* ── Schedules ──────────────────────────────────────────────────────────── */

describe("CRE cron schedules", () => {
  it("reads the workflows' schedules in words, with the next fire", () => {
    expect(describeCron("0 * * * * *")).toBe("Every minute");
    expect(describeCron("0 */10 * * * *")).toBe("Every 10 minutes");
    expect(describeCron("*/30 * * * * *")).toBe("Every 30 seconds");
    expect(describeCron("0 0 14 * * *")).toBe("Daily at 14:00 UTC");
    expect(describeCron("0 15 * * * *")).toBe("Hourly at :15");
    expect(describeCron("0 0 14 * * MON")).toBe("Cron 0 0 14 * * MON");
    const t = Date.UTC(2026, 9, 1, 10, 4, 30, 500);
    expect(new Date(nextCronFire("0 * * * * *", t)!).toISOString()).toBe("2026-10-01T10:05:00.000Z");
    expect(new Date(nextCronFire("0 */10 * * * *", t)!).toISOString()).toBe("2026-10-01T10:10:00.000Z");
    expect(new Date(nextCronFire("*/30 * * * * *", t)!).toISOString()).toBe("2026-10-01T10:05:00.000Z");
    expect(new Date(nextCronFire("0 0 14 * * *", t)!).toISOString()).toBe("2026-10-01T14:00:00.000Z");
    expect(new Date(nextCronFire("0 0 9 * * *", t)!).toISOString()).toBe("2026-10-02T09:00:00.000Z");
    expect(nextCronFire("0 0 14 * * MON", t)).toBeNull();
  });
});

/* ── Who stands behind a CRE report ─────────────────────────────────────── */

describe("report provenance (the app's \"Verified by Chainlink CRE\")", () => {
  beforeEach(() => resetProvenanceForTests());
  const testnet = { id: 10143, rpcUrl: "https://testnet-rpc.monad.xyz" };
  const [production] = CHAINLINK_FORWARDERS[10143]!.production;
  const [simulation] = CHAINLINK_FORWARDERS[10143]!.simulation;

  it("is verified only through Chainlink's KeystoneForwarder; the simulator's forwarder and a local chain say what they are", () => {
    expect(deliveryOf(production!, testnet)).toBe("don");
    expect(deliveryOf(production!.toLowerCase(), testnet)).toBe("don");
    expect(deliveryOf(simulation!, testnet)).toBe("simulation");
    expect(deliveryOf("0x00000000000000000000000000000000000f0a3d", testnet)).toBe("unknown");
    expect(deliveryOf(null, testnet)).toBe("unknown");
    // demo:local, or a node on this machine standing in for Monad testnet (even with a mock at Chainlink's address).
    expect(deliveryOf(production!, { id: 31337, rpcUrl: "http://127.0.0.1:8545" })).toBe("local");
    expect(deliveryOf(simulation!, { id: 10143, rpcUrl: "http://127.0.0.1:8620" })).toBe("local");
    expect(PROVENANCE_LABEL).toEqual({
      don: "Verified by Chainlink CRE",
      simulation: "Chainlink CRE (simulated)",
      local: "CRE workflow, local run",
      unknown: "CRE workflow report",
    });
  });

  it("names a local chain's delivery for what it is on the Chainlink page, not 'simulate --broadcast' (R1 B9)", () => {
    // The fork's deployment record says "simulation" (Chainlink's MockKeystoneForwarder is at its address), but the local runner sent the reports.
    const fork = { id: 10143, rpcUrl: "http://127.0.0.1:25545" };
    expect(forwarderKindOf("simulation", fork)).toBe("local");
    expect(forwarderKindOf("local", { id: 31337, rpcUrl: "http://127.0.0.1:8545" })).toBe("local");
    expect(forwarderKindOf("simulation", testnet)).toBe("simulation");
    expect(forwarderKindOf("production", testnet)).toBe("production");
    expect(forwarderKindOf(undefined, testnet)).toBeNull();
    expect(deliveryLabel("local")).toBe(PROVENANCE_LABEL.local);
    expect(deliveryLabel("simulation")).toContain("simulate --broadcast");
  });
});

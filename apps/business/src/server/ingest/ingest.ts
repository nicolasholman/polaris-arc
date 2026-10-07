import "server-only";

import {
  isDuplicateKeyError,
  SEALED_DESCRIPTION,
  type CheckoutMode,
  type CheckoutSessionRecord,
  type MerchantRecord,
  type PlanRecord,
  type SessionMismatch,
  type SessionPayment,
  type SubscriptionRecord,
} from "@polaris/db";
import { decodeEventLog, getAddress, type Abi, type Address, type Hex, type Log, type TransactionReceipt } from "viem";

import {
  collectionsReceiverAbi,
  guardianReceiverAbi,
  polarisCheckoutAbi,
  polarisLoanEngineAbi,
  polarisPaymentsAbi,
  polarisSplitAbi,
  underwritingReceiverAbi,
} from "../chain/abis";
import { publicClient, requireChain } from "../chain/client";
import { failureReasonOf } from "../chain/errors";
import { centsToUnits, formatUnits, installmentAmounts, thresholdFor, unitsToCents } from "../chain/money";
import { getDb } from "../db";
import type { ChainConfig } from "../env";
import { merchantByWallet } from "../merchants";
import { chargeReceipt, instalmentReceipt, paymentReceipt, planReceipt, scrubSession, sealIfInbox, subscriptionReceipt } from "../receipts";
import { periodSeconds } from "../sessions/params";
import { emitEvent } from "../webhooks/events";
import { recordSharePaid, recordSplitClosed, recordSplitCreated } from "../split";
import { onCollectionsReport, onGuardianReport, onReauthorized, onUnderwritingItem } from "./cre";

/**
 * Chain events in, records and webhooks out.
 *
 * "Paid" only ever comes from here: from the logs of a transaction that is
 * in a block (plan §5.6), never from what a client says. Two paths feed it:
 * the receipt of a transaction the relayer just sent (so the merchant's
 * webhook goes out in the same second), and the chain sync (so events the
 * relayer didn't send (CRE collections, renewals, liquidations, another
 * wallet's direct payment) arrive too). Both can see the same log; each log
 * is claimed once (`processed_logs`), and released again if handling fails
 * so the next sync retries it.
 */

type Contract = "payments" | "checkout" | "loanEngine" | "collections" | "underwriting" | "guardian" | "split";

type Decoded = {
  contract: Contract;
  eventName: string;
  args: Record<string, unknown>;
  address: Address;
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
};

const ABIS: Record<Contract, Abi> = {
  payments: polarisPaymentsAbi as unknown as Abi,
  checkout: polarisCheckoutAbi as unknown as Abi,
  loanEngine: polarisLoanEngineAbi as unknown as Abi,
  collections: collectionsReceiverAbi as unknown as Abi,
  underwriting: underwritingReceiverAbi as unknown as Abi,
  guardian: guardianReceiverAbi as unknown as Abi,
  split: polarisSplitAbi as unknown as Abi,
};

/** The contracts whose logs we read. */
export function watchedContracts(chain: ChainConfig): Record<Contract, Address | null> {
  return {
    payments: chain.contracts.payments,
    checkout: chain.contracts.checkout,
    loanEngine: chain.contracts.loanEngine,
    collections: chain.contracts.collections,
    // The other CRE receivers' reports, for the Chainlink page (./cre.ts).
    underwriting: chain.contracts.underwriting,
    guardian: chain.contracts.guardian,
    // Split-the-bill links: who paid which share and when (../split.ts). Null before PolarisSplit is deployed.
    split: chain.contracts.split,
  };
}

function decode(log: Log, chain: ChainConfig): Decoded | null {
  if (!log.transactionHash || log.logIndex === null || log.blockNumber === null) return null;
  const address = getAddress(log.address);
  const contract = (Object.entries(watchedContracts(chain)) as Array<[Contract, Address | null]>).find(([, a]) => a && getAddress(a) === address)?.[0];
  if (!contract) return null;
  try {
    const out = decodeEventLog({ abi: ABIS[contract], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return {
      contract,
      eventName: String(out.eventName),
      args: (out.args ?? {}) as Record<string, unknown>,
      address,
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      blockNumber: Number(log.blockNumber),
    };
  } catch {
    return null;
  }
}

/** Handle order within one transaction: the checkout's own events first, so a charge can find its subscription. */
const PRIORITY: Record<string, number> = { PlanOpened: 0, SubscriptionStarted: 0, CheckoutPaid: 0 };

type Ctx = {
  chain: ChainConfig;
  times: Map<number, string>;
  tx: Decoded[];
};

async function blockTime(ctx: Ctx, blockNumber: number): Promise<string> {
  const cached = ctx.times.get(blockNumber);
  if (cached) return cached;
  let iso: string;
  try {
    const block = await publicClient().getBlock({ blockNumber: BigInt(blockNumber) });
    iso = new Date(Number(block.timestamp) * 1000).toISOString();
  } catch {
    iso = new Date().toISOString();
  }
  ctx.times.set(blockNumber, iso);
  return iso;
}

const str = (v: unknown) => (typeof v === "bigint" ? v.toString() : String(v));
const big = (v: unknown) => (typeof v === "bigint" ? v : BigInt(str(v)));

export type IngestSummary = { handled: number; skipped: number; events: number };

/** Ingest a transaction the relayer sent, as soon as its receipt is in. */
export async function ingestReceipt(receipt: TransactionReceipt): Promise<IngestSummary> {
  const summary = await ingestLogs(receipt.logs as Log[]);
  await settleRelayAndPayout(receipt);
  return summary;
}

/** Ingest logs from any source, grouped and ordered per transaction. */
export async function ingestLogs(logs: readonly Log[]): Promise<IngestSummary> {
  const chain = requireChain();
  const decoded = logs.map((l) => decode(l, chain)).filter((d): d is Decoded => d !== null);
  const byTx = new Map<string, Decoded[]>();
  for (const d of decoded) {
    const list = byTx.get(d.txHash) ?? [];
    list.push(d);
    byTx.set(d.txHash, list);
  }
  const summary: IngestSummary = { handled: 0, skipped: logs.length - decoded.length, events: 0 };
  const times = new Map<number, string>();
  for (const tx of byTx.values()) {
    tx.sort((a, b) => (PRIORITY[a.eventName] ?? 1) - (PRIORITY[b.eventName] ?? 1) || a.logIndex - b.logIndex);
    const ctx: Ctx = { chain, times, tx };
    for (const log of tx) {
      const claimed = await claim(log);
      if (!claimed) {
        summary.skipped++;
        continue;
      }
      try {
        summary.events += await handle(log, ctx);
        summary.handled++;
      } catch (error) {
        if (await deadLetter(log, error)) {
          // Left claimed: skipped from now on, so the logs behind it (and the cursor) move on.
          summary.skipped++;
          continue;
        }
        await getDb().processedLogs.delete(`${log.txHash}:${log.logIndex}`);
        throw error;
      }
    }
  }
  return summary;
}

/** How many times a log's handler may fail before the log is set aside. */
export const MAX_LOG_ATTEMPTS = 5;

/**
 * Count a failed attempt at a log. Returns true once it has failed
 * MAX_LOG_ATTEMPTS times: it is then dead-lettered (recorded in
 * `failedLogs` with `deadAt`) instead of holding the chain sync forever.
 * Until then the caller releases its claim and the sync retries it.
 */
async function deadLetter(log: Decoded, error: unknown): Promise<boolean> {
  const db = getDb();
  const id = `${log.txHash}:${log.logIndex}`;
  const at = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  let record = await db.failedLogs.update(id, (f) => ({ ...f, attempts: f.attempts + 1, lastError: message, lastFailedAt: at }));
  if (!record) {
    try {
      record = await db.failedLogs.insert({
        id,
        txHash: log.txHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        event: `${log.contract}.${log.eventName}`,
        attempts: 1,
        lastError: message,
        firstFailedAt: at,
        lastFailedAt: at,
        deadAt: null,
      });
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
      record = await db.failedLogs.update(id, (f) => ({ ...f, attempts: f.attempts + 1, lastError: message, lastFailedAt: at }));
    }
  }
  if (!record || record.attempts < MAX_LOG_ATTEMPTS) return false;
  await db.failedLogs.update(id, (f) => ({ ...f, deadAt: f.deadAt ?? at }));
  console.error(`[ingest] ${record.event} at ${id} failed ${record.attempts} times: set aside (failed_logs). Last error: ${message}`);
  return true;
}

async function claim(log: Decoded): Promise<boolean> {
  try {
    await getDb().processedLogs.insert({ id: `${log.txHash}:${log.logIndex}`, txHash: log.txHash, blockNumber: log.blockNumber, at: new Date().toISOString() });
    return true;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

async function handle(log: Decoded, ctx: Ctx): Promise<number> {
  const key = `${log.contract}.${log.eventName}`;
  switch (key) {
    case "payments.PaymentMade":
      return onPaymentMade(log, ctx);
    case "checkout.PlanOpened":
      return onPlanOpened(log, ctx);
    case "checkout.SubscriptionStarted":
      return onSubscriptionStarted(log, ctx);
    case "payments.SubscriptionCharged":
      return onSubscriptionCharged(log, ctx);
    case "payments.SubscriptionCancelled":
      return onSubscriptionEnded(log, ctx, "cancelled");
    case "payments.SubscriptionLapsed":
      return onSubscriptionEnded(log, ctx, "lapsed");
    case "loanEngine.InstallmentPaid":
      return onInstallmentPaid(log, ctx);
    case "loanEngine.LoanFullyRepaid":
      return onLoanClosed(log, ctx, "repaid");
    case "loanEngine.LoanLiquidated":
      return onLoanClosed(log, ctx, "liquidated");
    case "collections.TaskSkipped":
      return onTaskSkipped(log, ctx);
    case "collections.CollectionsRun":
      return onCollectionsRun(log, ctx);
    case "checkout.Reauthorized":
      await onReauthorized(log, await blockTime(ctx, log.blockNumber));
      return 0;
    case "underwriting.UnderwritingApplied":
    case "underwriting.UnderwritingRefused":
      await onUnderwritingItem(log, await blockTime(ctx, log.blockNumber));
      return 0;
    case "guardian.CreditGuardUpdated":
    case "guardian.AttestationRefused":
      await onGuardianReport(log, await blockTime(ctx, log.blockNumber));
      return 0;
    case "split.SplitCreated": {
      const a = log.args;
      await recordSplitCreated(
        {
          splitId: a.splitId as Hex,
          organiser: getAddress(a.organiser as string),
          total: big(a.total),
          amounts: (a.amounts as readonly bigint[]).map(big),
          expiresAt: big(a.expiresAt),
          memoHash: a.memoHash as Hex,
          txHash: log.txHash,
          blockNumber: log.blockNumber,
        },
        await blockTime(ctx, log.blockNumber),
      );
      return 0;
    }
    case "split.SharePaid":
      await recordSharePaid(
        { splitId: log.args.splitId as Hex, index: big(log.args.index), payer: getAddress(log.args.payer as string), txHash: log.txHash },
        await blockTime(ctx, log.blockNumber),
      );
      return 0;
    case "split.SplitClosed":
      await recordSplitClosed({ splitId: log.args.splitId as Hex, txHash: log.txHash }, await blockTime(ctx, log.blockNumber));
      return 0;
    default:
      return 0;
  }
}

/* ── Sessions ───────────────────────────────────────────────────────────── */

async function sessionByOrderKey(orderKey: Hex): Promise<CheckoutSessionRecord | null> {
  return getDb().sessions.findOne({ orderKey: orderKey.toLowerCase() });
}

/** What a settlement of a session's order carried, to hold against the session. */
type Settlement = { mode: CheckoutMode; amount: bigint; planId?: string; periodSeconds?: number };

/**
 * Why this settlement doesn't pay this session, or null when it does.
 *
 * The order id is public (it's the session id, or in the hosted checkout's
 * view of the session), and anyone can settle an order on chain directly,
 * so a matching order key proves nothing about the price. A session is
 * complete only when what settled it is what it asked for: its amount (the
 * payment, the plan's principal, or the subscription's price), in a mode
 * it offers, and for "subscribe" its own plan and period. The on-chain
 * quote (sessions.ts `pinPrice`) makes a wrong amount revert in the first
 * place; this holds for sessions created without one.
 */
export function settlementMismatch(session: CheckoutSessionRecord, s: Settlement): string | null {
  const expected = centsToUnits(session.amountCents);
  if (!session.modes.includes(s.mode)) return `This checkout doesn't offer ${s.mode === "now" ? "paying in full" : s.mode === "later" ? "Pay in 4" : "a subscription"}.`;
  if (s.amount !== expected) return `Paid ${formatUnits(s.amount)} for a ${formatUnits(expected)} checkout.`;
  if (s.mode === "subscribe") {
    if (session.chain.subscriptionPlanId && s.planId !== session.chain.subscriptionPlanId) return `Subscribed to plan ${s.planId}, not this checkout's plan ${session.chain.subscriptionPlanId}.`;
    if (session.subscription && s.periodSeconds !== periodSeconds(session.subscription)) return "Subscribed with another billing period than this checkout's.";
  }
  return null;
}

/** Record a settlement that doesn't pay its session: on the session (never completing it), once per transaction. */
async function recordMismatch(session: CheckoutSessionRecord, mismatch: SessionMismatch): Promise<void> {
  await getDb().sessions.update(session.id, (s) => {
    const known = s.mismatches ?? [];
    if (known.some((m) => m.txHash === mismatch.txHash)) return s;
    return { ...s, mismatches: [...known, mismatch] };
  });
  console.warn(`[ingest] ${mismatch.txHash} settled the order of session ${session.id} without paying it: ${mismatch.reason}`);
}

/** Mark a session paid, once, and count it on its payment link. */
async function completeSession(session: CheckoutSessionRecord, payment: SessionPayment, at: string, amountCents: number): Promise<void> {
  const db = getDb();
  let transitioned = false;
  await db.sessions.update(session.id, (s) => {
    if (s.status === "complete") return s;
    transitioned = true;
    return { ...s, status: "complete", completedAt: at, payment };
  });
  if (transitioned && session.linkId) {
    await db.links.update(session.linkId, (l) => ({
      ...l,
      paymentsCount: l.paymentsCount + 1,
      collectedCents: l.collectedCents + amountCents,
      status: l.usage === "single" ? "used" : l.status,
    }));
  }
}

function orderRef(session: CheckoutSessionRecord | null, chainOrderId: string) {
  return { orderId: session?.orderId ?? chainOrderId, sessionId: session?.id ?? null, metadata: session?.metadata ?? {} };
}

/* ── Pay now ────────────────────────────────────────────────────────────── */

async function onPaymentMade(log: Decoded, ctx: Ctx): Promise<number> {
  const a = log.args;
  const paymentId = a.paymentId as Hex;
  const merchantAddress = getAddress(a.merchant as string);
  const merchant = await merchantByWallet(merchantAddress);
  if (!merchant) return 0;
  const session = await sessionByOrderKey(paymentId);
  const at = await blockTime(ctx, log.blockNumber);
  const amount = big(a.amount);
  const fee = big(a.fee);
  const payer = getAddress(a.payer as string);
  const chainOrderId = String(a.orderId);
  const mismatch = session ? settlementMismatch(session, { mode: "now", amount }) : null;
  // What was bought, sealed to the payer's receipts inbox when they have one (../receipts.ts). Never for
  // a settlement that doesn't pay its session: that payer isn't the session's buyer.
  const receiptId = mismatch ? null : await sealIfInbox(payer, () => paymentReceipt({ owner: payer, paymentId, merchant, session, amount, orderId: chainOrderId, txHash: log.txHash, at }));

  await getDb().payments.upsert({
    id: paymentId,
    merchantId: merchant.id,
    kind: "now",
    sessionId: session?.id ?? null,
    linkId: mismatch ? null : (session?.linkId ?? null),
    orderId: session?.orderId ?? chainOrderId,
    description: receiptId ? SEALED_DESCRIPTION : (session?.description ?? "Payment"),
    payer,
    amountUnits: amount.toString(),
    feeUnits: fee.toString(),
    txHash: log.txHash,
    blockNumber: log.blockNumber,
    createdAt: at,
    mismatch,
    receiptId,
  });
  if (session && mismatch) {
    await recordMismatch(session, { mode: "now", payer, txHash: log.txHash, reason: mismatch, expectedUnits: centsToUnits(session.amountCents).toString(), gotUnits: amount.toString(), at });
    // The order is not paid: no payment.succeeded, which a merchant would fulfil on.
    return 0;
  }
  if (merchant.registration.state === "registered") {
    // Settlement history is what automatic Pay in 4 activation waits for (onboarding.ts).
    try {
      const { activateIfEligible } = await import("../onboarding");
      await activateIfEligible(merchant.id);
    } catch (error) {
      console.error("[ingest] activation check failed; it runs again on the next payment", error);
    }
  }
  if (session) {
    await completeSession(
      session,
      { mode: "now", payer, txHash: log.txHash, chainId: ctx.chain.id, paymentId, planId: null, subscriptionId: null },
      at,
      unitsToCents(amount),
    );
    // Sealed: the session keeps no description or line items.
    if (receiptId) await scrubSession(session.id, at);
  }
  await emitEvent({
    merchant,
    type: "payment.succeeded",
    sourceKey: `${log.txHash}:${log.logIndex}:payment.succeeded`,
    data: {
      ...orderRef(session, chainOrderId),
      paymentId,
      mode: "now",
      merchant: merchantAddress,
      payer,
      amount: formatUnits(amount),
      fee: formatUnits(fee),
      currency: "USD",
      txHash: log.txHash,
      chainId: ctx.chain.id,
    },
  });
  return 1;
}

/* ── Pay in 4 ───────────────────────────────────────────────────────────── */

function schedule(plan: Pick<PlanRecord, "totalOwedUnits" | "installments" | "startedAt" | "intervalSeconds">) {
  return installmentAmounts(BigInt(plan.totalOwedUnits), plan.installments).map((amount, i) => ({
    index: i + 1,
    amount: formatUnits(amount),
    dueAt: new Date((plan.startedAt + (i + 1) * plan.intervalSeconds) * 1000).toISOString(),
  }));
}

async function onPlanOpened(log: Decoded, ctx: Ctx): Promise<number> {
  const a = log.args;
  const merchantAddress = getAddress(a.merchant as string);
  const merchant = await merchantByWallet(merchantAddress);
  if (!merchant) return 0;
  const db = getDb();
  const orderKey = a.orderKey as Hex;
  const session = await sessionByOrderKey(orderKey);
  const at = await blockTime(ctx, log.blockNumber);
  const loanId = str(a.loanId);
  const principal = big(a.principal);
  const totalOwed = big(a.totalOwed);
  const installments = Number(a.installments);
  const interval = Number(a.interval);
  const startedAt = Number(a.firstDueAt) - interval;
  const borrower = getAddress(a.buyer as string);
  const chainOrderId = String(a.orderId);
  const mismatch = session ? settlementMismatch(session, { mode: "later", amount: principal }) : null;

  const existing = await db.plans.get(loanId);
  let plan: PlanRecord = existing ?? {
    id: loanId,
    merchantId: merchant.id,
    sessionId: mismatch ? null : (session?.id ?? null),
    orderId: session?.orderId ?? chainOrderId,
    description: session?.description ?? "Pay in 4",
    borrower,
    principalUnits: principal.toString(),
    totalOwedUnits: totalOwed.toString(),
    repaidUnits: "0",
    installments,
    installmentsPaid: 0,
    intervalSeconds: interval,
    startedAt,
    state: "collecting",
    attempts: 0,
    lastFailure: null,
    openedTxHash: log.txHash,
    createdAt: at,
    updatedAt: at,
  };
  if (!existing) {
    const opened = plan;
    const receiptId = mismatch ? null : await sealIfInbox(borrower, () => planReceipt({ plan: opened, merchant, session, description: session && !session.sealedAt ? session.description : null }));
    if (receiptId) plan = { ...plan, description: SEALED_DESCRIPTION, receiptId };
    await db.plans.upsert(plan);
  }
  await db.payments.upsert({
    id: `plan:${loanId}`,
    merchantId: merchant.id,
    kind: "later",
    sessionId: session?.id ?? null,
    linkId: mismatch ? null : (session?.linkId ?? null),
    orderId: plan.orderId,
    description: plan.description,
    payer: borrower,
    amountUnits: principal.toString(),
    feeUnits: "0",
    txHash: log.txHash,
    blockNumber: log.blockNumber,
    createdAt: at,
    mismatch,
    receiptId: plan.receiptId ?? null,
  });
  if (session && mismatch) {
    await recordMismatch(session, { mode: "later", payer: borrower, txHash: log.txHash, reason: mismatch, expectedUnits: centsToUnits(session.amountCents).toString(), gotUnits: principal.toString(), at });
    return 0;
  }
  if (session) {
    await completeSession(
      session,
      { mode: "later", payer: borrower, txHash: log.txHash, chainId: ctx.chain.id, paymentId: null, planId: loanId, subscriptionId: null },
      at,
      unitsToCents(principal),
    );
    if (plan.receiptId) await scrubSession(session.id, at);
  }
  await emitEvent({
    merchant,
    type: "plan.opened",
    sourceKey: `${log.txHash}:${log.logIndex}:plan.opened`,
    data: {
      ...orderRef(session, chainOrderId),
      planId: loanId,
      mode: "later",
      merchant: merchantAddress,
      borrower,
      principal: formatUnits(principal),
      interest: formatUnits(totalOwed - principal),
      total: formatUnits(totalOwed),
      installments,
      intervalSeconds: interval,
      schedule: schedule(plan),
      currency: "USD",
      txHash: log.txHash,
      chainId: ctx.chain.id,
    },
  });
  return 1;
}

/** A plan we didn't see open (a database reset, or opened before we were watching): read it from the chain. */
async function planFromChain(loanId: string, at: string): Promise<{ plan: PlanRecord; merchant: MerchantRecord } | null> {
  const chain = requireChain();
  const loan = (await publicClient().readContract({
    address: chain.contracts.loanEngine,
    abi: polarisLoanEngineAbi,
    functionName: "getLoan",
    args: [BigInt(loanId)],
  })) as { borrower: Address; merchant: Address; principal: bigint; totalOwed: bigint; totalRepaid: bigint; installmentCount: number; installmentsPaid: number; startedAt: bigint; intervalSeconds: bigint };
  const merchant = await merchantByWallet(loan.merchant);
  if (!merchant) return null;
  const plan: PlanRecord = {
    id: loanId,
    merchantId: merchant.id,
    sessionId: null,
    orderId: `loan-${loanId}`,
    description: "Pay in 4",
    borrower: getAddress(loan.borrower),
    principalUnits: loan.principal.toString(),
    totalOwedUnits: loan.totalOwed.toString(),
    repaidUnits: "0",
    installments: Number(loan.installmentCount),
    installmentsPaid: 0,
    intervalSeconds: Number(loan.intervalSeconds),
    startedAt: Number(loan.startedAt),
    state: "collecting",
    attempts: 0,
    lastFailure: null,
    openedTxHash: "0x" as Hex,
    createdAt: at,
    updatedAt: at,
  };
  await getDb().plans.upsert(plan);
  return { plan, merchant };
}

async function planAndMerchant(loanId: string, at: string): Promise<{ plan: PlanRecord; merchant: MerchantRecord } | null> {
  const db = getDb();
  const plan = await db.plans.get(loanId);
  if (plan) {
    const merchant = await db.merchants.get(plan.merchantId);
    return merchant ? { plan, merchant } : null;
  }
  return planFromChain(loanId, at);
}

function earned(totalOwed: bigint, installments: number, repaid: bigint): number {
  let k = 0;
  while (k < installments && repaid >= thresholdFor(totalOwed, installments, k + 1)) k++;
  return k;
}

async function onInstallmentPaid(log: Decoded, ctx: Ctx): Promise<number> {
  const at = await blockTime(ctx, log.blockNumber);
  const found = await planAndMerchant(str(log.args.loanId), at);
  if (!found) return 0;
  const { merchant } = found;
  const amount = big(log.args.amount);
  let before = 0;
  let after = 0;
  let updated: PlanRecord | null = null;
  updated = await getDb().plans.update(found.plan.id, (p) => {
    const total = BigInt(p.totalOwedUnits);
    const repaid = BigInt(p.repaidUnits) + amount;
    before = p.installmentsPaid;
    after = earned(total, p.installments, repaid);
    const progressed = after > before;
    return {
      ...p,
      repaidUnits: repaid.toString(),
      installmentsPaid: after,
      attempts: progressed ? 0 : p.attempts,
      lastFailure: progressed ? null : p.lastFailure,
      // The collection that followed the buyer signing again (shown in the app as "Collected").
      reauthorized: p.reauthorized && progressed && !p.reauthorized.collected ? { ...p.reauthorized, collected: { at, txHash: log.txHash } } : (p.reauthorized ?? null),
      state: p.state === "dunning" && progressed ? "collecting" : p.state,
      updatedAt: at,
    };
  });
  if (!updated) return 0;
  const plan: PlanRecord = updated;
  const total = BigInt(plan.totalOwedUnits);
  const ladder = installmentAmounts(total, plan.installments);
  let events = 0;
  for (let k = before + 1; k <= after; k++) {
    // The collection's receipt, sealed as it is written: which instalment, pointing at the plan's receipt.
    await sealIfInbox(plan.borrower, () => instalmentReceipt({ plan, merchant, index: k, amount: ladder[k - 1] ?? 0n, txHash: log.txHash, at }));
    const remaining = k === after ? total - BigInt(plan.repaidUnits) : total - thresholdFor(total, plan.installments, k);
    await emitEvent({
      merchant,
      type: "installment.collected",
      sourceKey: `${log.txHash}:${log.logIndex}:installment.collected:${k}`,
      data: {
        planId: plan.id,
        orderId: plan.orderId,
        installment: k,
        installments: plan.installments,
        amount: formatUnits(ladder[k - 1] ?? 0n),
        remaining: formatUnits(remaining < 0n ? 0n : remaining),
        txHash: log.txHash,
        chainId: ctx.chain.id,
      },
    });
    events++;
  }
  return events;
}

async function onLoanClosed(log: Decoded, ctx: Ctx, how: "repaid" | "liquidated"): Promise<number> {
  const at = await blockTime(ctx, log.blockNumber);
  const found = await planAndMerchant(str(log.args.loanId), at);
  if (!found) return 0;
  const plan = (await getDb().plans.update(found.plan.id, (p) => ({
    ...p,
    state: how === "repaid" ? "repaid" : "written_off",
    installmentsPaid: how === "repaid" ? p.installments : p.installmentsPaid,
    repaidUnits: how === "repaid" ? p.totalOwedUnits : p.repaidUnits,
    updatedAt: at,
  }))) as PlanRecord;
  if (how === "repaid") {
    await emitEvent({
      merchant: found.merchant,
      type: "plan.completed",
      sourceKey: `${log.txHash}:${log.logIndex}:plan.completed`,
      data: { planId: plan.id, orderId: plan.orderId, total: formatUnits(BigInt(plan.totalOwedUnits)), txHash: log.txHash, chainId: ctx.chain.id },
    });
  } else {
    await emitEvent({
      merchant: found.merchant,
      type: "plan.liquidated",
      sourceKey: `${log.txHash}:${log.logIndex}:plan.liquidated`,
      data: {
        planId: plan.id,
        orderId: plan.orderId,
        outstanding: formatUnits(big(log.args.outstanding)),
        recovered: formatUnits(big(log.args.recovered)),
        txHash: log.txHash,
        chainId: ctx.chain.id,
      },
    });
  }
  return 1;
}

/**
 * The dunning ladder (packages/keeperhub/src/dunning.ts): after a miss, the
 * next attempt that counts is 6 h, 24 h, 72 h, then 168 h later; after that
 * the plan is a liquidation candidate. CRE's collections workflow runs every
 * minute and reports a skip each time, so a skip inside the current wait is
 * the same miss, not a new one, and sends no second webhook.
 */
export const DUNNING_HOURS = [6, 24, 72, 168] as const;

async function onTaskSkipped(log: Decoded, ctx: Ctx): Promise<number> {
  if (Number(log.args.action) !== 1) return 0; // only instalments dun; renewals lapse on chain
  const reason = failureReasonOf(log.args.reason as Hex);
  if (reason === "stale") return 0;
  const at = await blockTime(ctx, log.blockNumber);
  const found = await planAndMerchant(str(log.args.id), at);
  if (!found) return 0;
  const nowMs = Date.parse(at);
  let counted = false;
  const plan = (await getDb().plans.update(found.plan.id, (p) => {
    const waiting = p.lastFailure?.nextAttemptAt ? nowMs < Date.parse(p.lastFailure.nextAttemptAt) : false;
    if (waiting || p.state === "repaid" || p.state === "written_off") return p;
    counted = true;
    const attempts = p.attempts + 1;
    const hours = DUNNING_HOURS[attempts - 1];
    return {
      ...p,
      state: "dunning",
      attempts,
      lastFailure: { reason, at, nextAttemptAt: hours === undefined ? null : new Date(nowMs + hours * 3_600_000).toISOString() },
      reauthorized: null,
      updatedAt: at,
    };
  })) as PlanRecord;
  if (!counted) return 0;
  const ladder = installmentAmounts(BigInt(plan.totalOwedUnits), plan.installments);
  const next = Math.min(plan.installmentsPaid, plan.installments - 1);
  await emitEvent({
    merchant: found.merchant,
    type: "installment.failed",
    sourceKey: `${log.txHash}:${log.logIndex}:installment.failed`,
    data: {
      planId: plan.id,
      orderId: plan.orderId,
      installment: next + 1,
      amount: formatUnits(ladder[next] ?? 0n),
      reason: reason === "insufficient_funds" || reason === "allowance_lost" ? reason : "other",
      attempt: plan.attempts,
      nextAttemptAt: plan.lastFailure?.nextAttemptAt ?? null,
      chainId: ctx.chain.id,
    },
  });
  return 1;
}

async function onCollectionsRun(log: Decoded, ctx: Ctx): Promise<number> {
  const at = await blockTime(ctx, log.blockNumber);
  await getDb().collectorRuns.upsert({
    id: "cre",
    lastRunAt: at,
    lastRunBlock: log.blockNumber,
    lastTxHash: log.txHash,
    tasks: Number(log.args.tasks),
    executed: Number(log.args.executed),
    skipped: Number(log.args.skipped),
  });
  await onCollectionsReport(log, at, ctx.tx);
  return 0;
}

/* ── Subscriptions ──────────────────────────────────────────────────────── */

async function onSubscriptionStarted(log: Decoded, ctx: Ctx): Promise<number> {
  const a = log.args;
  const merchantAddress = getAddress(a.merchant as string);
  const merchant = await merchantByWallet(merchantAddress);
  if (!merchant) return 0;
  const session = await sessionByOrderKey(a.orderKey as Hex);
  const at = await blockTime(ctx, log.blockNumber);
  const subId = str(a.subId);
  const price = big(a.pricePerPeriod);
  const buyer = getAddress(a.buyer as string);
  const mismatch = session ? settlementMismatch(session, { mode: "subscribe", amount: price, planId: str(a.planId), periodSeconds: Number(a.periodSeconds) }) : null;
  const db = getDb();
  const existing = await db.subscriptions.get(subId);
  await db.subscriptions.upsert({
    id: subId,
    merchantId: merchant.id,
    planId: str(a.planId),
    subscriber: buyer,
    priceUnits: price.toString(),
    periodSeconds: Number(a.periodSeconds),
    periodsCharged: existing?.periodsCharged ?? 0,
    nextChargeAt: Number(a.nextChargeAt),
    status: existing?.status ?? "active",
    orderId: session?.orderId ?? String(a.orderId),
    sessionId: mismatch ? null : (session?.id ?? null),
    receiptId: existing?.receiptId ?? null,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  });
  // What was subscribed to, sealed to the buyer's inbox; each charge's receipt points at it.
  let receiptId = existing?.receiptId ?? null;
  if (!receiptId && session && !mismatch) {
    const sub = await db.subscriptions.get(subId);
    receiptId = sub ? await sealIfInbox(buyer, () => subscriptionReceipt({ sub, merchant, session, txHash: log.txHash, at })) : null;
    if (receiptId) {
      const id = receiptId;
      await db.subscriptions.update(subId, (s) => ({ ...s, receiptId: id }));
    }
  }
  if (session && mismatch) {
    await recordMismatch(session, { mode: "subscribe", payer: buyer, txHash: log.txHash, reason: mismatch, expectedUnits: centsToUnits(session.amountCents).toString(), gotUnits: price.toString(), at });
    return 0;
  }
  if (session) {
    await completeSession(
      session,
      { mode: "subscribe", payer: getAddress(a.buyer as string), txHash: log.txHash, chainId: ctx.chain.id, paymentId: null, planId: null, subscriptionId: subId },
      at,
      unitsToCents(big(a.pricePerPeriod)),
    );
    if (receiptId) await scrubSession(session.id, at);
  }
  return 0;
}

async function subscriptionFromChain(subId: string, at: string): Promise<{ sub: SubscriptionRecord; merchant: MerchantRecord } | null> {
  const chain = requireChain();
  const client = publicClient();
  const s = (await client.readContract({ address: chain.contracts.payments, abi: polarisPaymentsAbi, functionName: "getSubscription", args: [BigInt(subId)] })) as {
    subscriber: Address;
    planId: bigint;
    nextChargeAt: bigint;
    periodsCharged: number;
  };
  const plan = (await client.readContract({ address: chain.contracts.payments, abi: polarisPaymentsAbi, functionName: "getPlan", args: [s.planId] })) as {
    merchant: Address;
    pricePerPeriod: bigint;
    periodSeconds: bigint;
  };
  const merchant = await merchantByWallet(plan.merchant);
  if (!merchant) return null;
  const sub: SubscriptionRecord = {
    id: subId,
    merchantId: merchant.id,
    planId: s.planId.toString(),
    subscriber: getAddress(s.subscriber),
    priceUnits: plan.pricePerPeriod.toString(),
    periodSeconds: Number(plan.periodSeconds),
    periodsCharged: 0,
    nextChargeAt: Number(s.nextChargeAt),
    status: "active",
    orderId: null,
    sessionId: null,
    createdAt: at,
    updatedAt: at,
  };
  await getDb().subscriptions.upsert(sub);
  return { sub, merchant };
}

async function subscriptionAndMerchant(subId: string, at: string): Promise<{ sub: SubscriptionRecord; merchant: MerchantRecord } | null> {
  const db = getDb();
  const sub = await db.subscriptions.get(subId);
  if (sub) {
    const merchant = await db.merchants.get(sub.merchantId);
    return merchant ? { sub, merchant } : null;
  }
  return subscriptionFromChain(subId, at);
}

/** A subscription charge's line: its checkout's description, and which month it is after the first. */
function subscriptionDescription(session: CheckoutSessionRecord | null, period: number): string {
  const what = session?.description?.trim() || "Subscription";
  return period === 1 ? what : `${what}, period ${period}`;
}

async function onSubscriptionCharged(log: Decoded, ctx: Ctx): Promise<number> {
  const at = await blockTime(ctx, log.blockNumber);
  const subId = str(log.args.subId);
  const found = await subscriptionAndMerchant(subId, at);
  if (!found) return 0;
  const period = Number(log.args.period);
  const amount = big(log.args.amount);
  const fee = big(log.args.fee);
  let nextChargeAt = found.sub.nextChargeAt;
  try {
    const s = (await publicClient().readContract({
      address: ctx.chain.contracts.payments,
      abi: polarisPaymentsAbi,
      functionName: "getSubscription",
      args: [BigInt(subId)],
      blockNumber: BigInt(log.blockNumber),
    })) as { nextChargeAt: bigint };
    nextChargeAt = Number(s.nextChargeAt);
  } catch {
    nextChargeAt = found.sub.nextChargeAt + (period > found.sub.periodsCharged ? found.sub.periodSeconds : 0);
  }
  const db = getDb();
  const sub = (await db.subscriptions.update(subId, (s) => ({
    ...s,
    periodsCharged: Math.max(s.periodsCharged, period),
    nextChargeAt,
    updatedAt: at,
  }))) as SubscriptionRecord;
  const merchantAddress = found.merchant.walletAddress ?? ("0x" as Address);
  const session = sub.sessionId ? await db.sessions.get(sub.sessionId) : null;
  // The line in the clear, while the checkout still has its description (no inbox, or not sealed yet).
  const clear = session && !session.sealedAt ? subscriptionDescription(session, period) : null;
  const paymentId = `sub:${subId}:${period}`;
  // The server writes this receipt when the buyer isn't there: sealed with their public key as it is written.
  const receiptId = await sealIfInbox(sub.subscriber, () =>
    chargeReceipt({ sub, merchant: found.merchant, paymentId, period, amount, description: clear, txHash: log.txHash, at }),
  );
  await db.payments.upsert({
    id: paymentId,
    merchantId: found.merchant.id,
    kind: "subscription",
    sessionId: sub.sessionId,
    linkId: null,
    orderId: sub.orderId ?? `sub-${subId}`,
    // What the buyer subscribed to, from its checkout ("Halcyon Coffee Club, monthly · HC-94626"), as Pay now and Pay in 4 do;
    // sealed to the buyer instead when they have a receipts inbox.
    description: receiptId ? SEALED_DESCRIPTION : (clear ?? subscriptionDescription(null, period)),
    receiptId,
    payer: sub.subscriber,
    amountUnits: amount.toString(),
    feeUnits: fee.toString(),
    txHash: log.txHash,
    blockNumber: log.blockNumber,
    createdAt: at,
  });
  await emitEvent({
    merchant: found.merchant,
    type: "subscription.charged",
    sourceKey: `${log.txHash}:${log.logIndex}:subscription.charged`,
    data: {
      subscriptionId: subId,
      planId: sub.planId,
      merchant: merchantAddress,
      subscriber: sub.subscriber,
      amount: formatUnits(amount),
      fee: formatUnits(fee),
      period,
      nextChargeAt: new Date(nextChargeAt * 1000).toISOString(),
      orderId: sub.orderId,
      sessionId: sub.sessionId,
      txHash: log.txHash,
      chainId: ctx.chain.id,
    },
  });
  return 1;
}

async function onSubscriptionEnded(log: Decoded, ctx: Ctx, how: "cancelled" | "lapsed"): Promise<number> {
  const at = await blockTime(ctx, log.blockNumber);
  const subId = str(log.args.subId);
  const found = await subscriptionAndMerchant(subId, at);
  if (!found) return 0;
  const sub = (await getDb().subscriptions.update(subId, (s) => ({ ...s, status: how === "lapsed" ? "lapsed" : "canceled", updatedAt: at }))) as SubscriptionRecord;
  let canceledBy: "subscriber" | "merchant" | "lapsed" = "lapsed";
  if (how === "cancelled") {
    const by = getAddress(log.args.by as string);
    canceledBy = found.merchant.walletAddress && by === found.merchant.walletAddress ? "merchant" : "subscriber";
  }
  await emitEvent({
    merchant: found.merchant,
    type: "subscription.canceled",
    sourceKey: `${log.txHash}:${log.logIndex}:subscription.canceled`,
    data: {
      subscriptionId: subId,
      planId: sub.planId,
      merchant: found.merchant.walletAddress,
      subscriber: sub.subscriber,
      canceledBy,
      txHash: log.txHash,
      chainId: ctx.chain.id,
    },
  });
  return 1;
}

/* ── The relayer's own bookkeeping, and payouts ─────────────────────────── */

async function settleRelayAndPayout(receipt: TransactionReceipt): Promise<void> {
  const db = getDb();
  const chain = requireChain();
  const hash = receipt.transactionHash.toLowerCase();
  const ok = receipt.status === "success";
  const relay = await db.relays.findOne({ txHash: hash });
  if (relay && (relay.state === "submitted" || relay.state === "pending")) {
    await db.relays.update(relay.id, (r) => ({
      ...r,
      state: ok ? "confirmed" : "failed",
      blockNumber: Number(receipt.blockNumber),
      error: ok ? null : { code: "reverted", message: "The transaction reverted." },
      updatedAt: new Date().toISOString(),
    }));
  }
  const payout = await db.payouts.findOne({ txHash: hash });
  if (payout && payout.state !== "paid" && payout.state !== "failed") {
    const paidAt = new Date().toISOString();
    await db.payouts.update(payout.id, (p) => ({ ...p, state: ok ? "paid" : "failed", paidAt: ok ? paidAt : null, error: ok ? null : "The transfer reverted." }));
    if (ok) {
      const merchant = await db.merchants.get(payout.merchantId);
      if (merchant) {
        await emitEvent({
          merchant,
          type: "payout.paid",
          sourceKey: `${receipt.transactionHash}:payout:${payout.id}`,
          data: {
            payoutId: payout.id,
            amount: formatUnits(BigInt(payout.amountUnits)),
            destination: payout.destination,
            automatic: payout.kind === "automatic",
            txHash: receipt.transactionHash,
            chainId: chain.id,
          },
        });
      }
    }
  }
}

/** Ids a receipt yielded, for the relay response. */
export function idsFromReceipt(receipt: TransactionReceipt, chain: ChainConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const log of receipt.logs as Log[]) {
    const d = decode(log, chain);
    if (!d) continue;
    if (d.eventName === "PaymentMade") out.paymentId = String(d.args.paymentId);
    if (d.eventName === "PlanOpened") {
      out.planId = str(d.args.loanId);
      out.orderKey = String(d.args.orderKey);
    }
    if (d.eventName === "SubscriptionStarted") {
      out.subscriptionId = str(d.args.subId);
      out.orderKey = String(d.args.orderKey);
    }
    if (d.eventName === "CheckoutPaid") out.orderKey = String(d.args.orderKey);
  }
  return out;
}

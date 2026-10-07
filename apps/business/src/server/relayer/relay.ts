import "server-only";

import type { MerchantRecord } from "@polaris/db";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

import {
  collateralVaultAbi,
  iausdAbi,
  polarisCheckoutAbi,
  polarisLoanEngineAbi,
  polarisPaymentsAbi,
  polarisSendAbi,
  polarisSplitAbi,
} from "../chain/abis";
import { publicClient, requireChain } from "../chain/client";
import { centsToUnits, formatUnits } from "../chain/money";
import { getDb } from "../db";
import { getConfig, type ChainConfig } from "../env";
import { HttpError } from "../http";
import { consume, LIMITS } from "../ratelimit";
import { dropAfterMs } from "../ingest/sync";
import { ensureQuoted, orderKeyOf, openSessionForPayment } from "../sessions/sessions";
import { periodSeconds } from "../sessions/params";
import { vaultWithdrawDomain } from "../vault";
import { MAX_SHARES, readSplit, requireSplitContract, shareNonce, SPLIT_MAX_EXPIRY, SPLIT_MIN_LIFETIME, splitIdOf } from "../split";
import { carry, fromRecord, type RelayResult } from "./carry";
import { address, bad, bytes32, deadline, field, signature, text, uint, vrs } from "./parse";
import { polarisDomain, TYPES, type Domain } from "./typed-data";

/**
 * `POST /api/relay`: every buyer action, carried.
 *
 * The buyer (sender, borrower, subscriber) signs; this checks the request's
 * shape, rebuilds the exact typed data the contract will check and verifies
 * the signature recovers to the account named in it; for checkout actions,
 * checks every signed field against the session the merchant created; then
 * simulates and submits through the relayer's server wallet (carry.ts). The
 * contract checks everything again: this layer exists so that a request that
 * would fail is refused before it costs gas, with a message the buyer can
 * act on, and so the relayer never becomes a free way to spam the chain.
 *
 * | type                 | who signs                  | the relayer calls                           |
 * |----------------------|----------------------------|---------------------------------------------|
 * | `pay`                | buyer: ReceiveWithAuth.    | PolarisCheckout.pay                         |
 * | `openPlan`           | buyer: PlanIntent + Permit | PolarisCheckout.openPlan                    |
 * | `subscribe`          | buyer: SubscribeIntent + Permit | PolarisCheckout.subscribe              |
 * | `send`               | sender: ReceiveWithAuth. + link key: Open | PolarisSend.send             |
 * | `claim`              | link key: Claim            | PolarisSend.claim                           |
 * | `cancelSend`         | sender: Cancel             | PolarisSend.cancel                          |
 * | `repay`              | borrower: RepayIntent      | PolarisLoanEngine.repayWithSig              |
 * | `reauthorize`        | borrower: Permit (engine)  | PolarisCheckout.reauthorize                 |
 * | `lockCollateral`     | borrower: Permit (vault)   | CollateralVault.lockWithPermit              |
 * | `withdrawCollateral` | borrower: Withdraw         | CollateralVault.withdrawWithSig             |
 * | `cancelSubscription` | subscriber: CancelSubscription | PolarisPayments.cancelWithSignature     |
 * | `transfer`           | owner: TransferWithAuth.   | AUSD.transferWithAuthorization              |
 * | `createSplit`        | organiser: CreateSplit     | PolarisSplit.createSplit                    |
 * | `payShare`           | friend: ReceiveWithAuth.   | PolarisSplit.payShare                       |
 * | `closeSplit`         | organiser: CloseSplit      | PolarisSplit.closeSplit                     |
 */

export const RELAY_TYPES = [
  "pay",
  "openPlan",
  "subscribe",
  "send",
  "claim",
  "cancelSend",
  "repay",
  "reauthorize",
  "lockCollateral",
  "withdrawCollateral",
  "cancelSubscription",
  "transfer",
  "createSplit",
  "payShare",
  "closeSplit",
] as const;
export type RelayType = (typeof RELAY_TYPES)[number];

export type RelayResponse = {
  type: RelayType | "payWithAuthorization";
  txHash: Hex;
  status: "submitted" | "confirmed";
  blockNumber: number | null;
  explorerUrl: string | null;
  submittedAt: number;
  confirmedAt: number | null;
  sessionId: string | null;
  paymentId?: string;
  planId?: string;
  subscriptionId?: string;
  orderKey?: string;
  /** createSplit, payShare, closeSplit: the split, and for payShare the share. */
  splitId?: string;
  shareIndex?: string;
};

const now = () => Math.floor(Date.now() / 1000);

function stablecoinDomain(chain: ChainConfig): Domain {
  return { ...chain.stablecoinDomain, chainId: chain.id, verifyingContract: chain.contracts.stablecoin };
}

function relayIdOf(type: string, ...signatures: Hex[]): string {
  return `sig:${keccak256(stringToHex(`${type}:${signatures.join(":")}`)).slice(2, 42)}`;
}

async function assertSigner(expected: Address, recover: Promise<Address>, what: string): Promise<void> {
  let recovered: Address;
  try {
    recovered = await recover;
  } catch {
    throw new HttpError(400, "invalid_signature", `That confirmation didn't go through (${what}). Try again.`);
  }
  if (getAddress(recovered) !== getAddress(expected)) {
    throw new HttpError(400, "invalid_signature", `That confirmation didn't come from this account (${what}).`);
  }
}

/**
 * Count a request against the account that signed it, once every signature
 * in it has been verified. Never before: a request naming someone else's
 * account with a junk signature would otherwise spend that account's
 * allowance and lock them out of checkout. Unverified requests are bounded
 * by the per-IP limit in front of the route (auth.ts `withSignedRequest`).
 *
 * Each account also has a daily budget. And `open` requests (transfers and
 * sends by link, which need no merchant's checkout and so can be made by
 * anyone with a fresh key and a little AUSD) share one global budget, a
 * circuit breaker on what the relayer can be made to spend on strangers.
 */
function countVerified(signer: Address, options: { open?: boolean } = {}): void {
  const key = getAddress(signer);
  consume(LIMITS.relayPerSigner, key);
  consume(LIMITS.relayPerSignerDaily, key);
  if (options.open) consume(LIMITS.relayOpenGlobal, "all");
}

/** The smallest transfer or send the relayer carries (and the Privy policy signs). */
function assertMinimum(amount: bigint, param: string): void {
  const min = getConfig().relayerLimits.minTransferUnits;
  if (amount < min) bad(param, `${param} must be at least ${formatUnits(min)} AUSD.`);
}

/**
 * One settlement per checkout: while a relay for this session is in flight,
 * a second, different signature (Pay now after Pay in 4, a double tap with a
 * fresh signature) is refused instead of being sent to revert on chain. The
 * same signatures again are fine: `carry` returns the first transaction.
 */
async function assertNothingInFlight(sessionId: string, relayId: string): Promise<void> {
  const inFlight = await getDb().relays.findOne({ sessionId, state: { in: ["pending", "submitted"] } });
  const age = inFlight ? Date.now() - Date.parse(inFlight.createdAt) : 0;
  // A "pending" relay older than two minutes died before it was sent. A "submitted" one with no receipt after
  // RELAYER_DROP_AFTER_MS was most likely dropped (the reconciler will say so): it no longer holds the checkout.
  // If it lands after all, the contracts settle the order once, and the chain sync records whichever did.
  const abandoned = inFlight?.state === "pending" ? age > 120_000 : age > dropAfterMs();
  if (inFlight && inFlight.id !== relayId && !abandoned) {
    throw new HttpError(409, "payment_in_progress", "This checkout is already being paid. Give it a second.", { headers: { "Retry-After": "1" } });
  }
}

function respond(type: RelayResponse["type"], result: RelayResult, sessionId: string | null): RelayResponse {
  return {
    type,
    txHash: result.txHash,
    status: result.status,
    blockNumber: result.blockNumber,
    explorerUrl: result.explorerUrl,
    submittedAt: result.submittedAt,
    confirmedAt: result.confirmedAt,
    sessionId,
    ...result.ids,
  };
}

/**
 * The same signed request again (a retry after a lost response, a double
 * tap): answer with the first one's transaction before anything else, even
 * though its session is now paid.
 */
async function replay(type: RelayResponse["type"], relayId: string): Promise<RelayResponse | null> {
  const known = await getDb().relays.get(relayId);
  if (!known || known.state === "failed" || known.state === "pending" || !known.txHash) return null;
  return respond(type, fromRecord(known), known.sessionId);
}

/* ── Permits ────────────────────────────────────────────────────────────── */

type PermitArg = { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex };
const NO_PERMIT: PermitArg = { value: 0n, deadline: 0n, v: 0, r: zeroHash, s: zeroHash };

/** An ERC-2612 permit for `spender`, verified against the token's current nonce. Absent means "use the standing allowance". */
async function permitOf(body: Record<string, unknown>, owner: Address, spender: Address, chain: ChainConfig): Promise<{ permit: PermitArg; sig: Hex | null }> {
  if (body.permit === undefined || body.permit === null) return { permit: NO_PERMIT, sig: null };
  const value = uint(body, "permit.value");
  const permitDeadline = deadline(uint(body, "permit.deadline"), "permit.deadline", { maxAheadSeconds: 3 * 3600 });
  const sig = signature(body, "permit.signature");
  const nonce = (await publicClient().readContract({ address: chain.contracts.stablecoin, abi: iausdAbi, functionName: "nonces", args: [owner] })) as bigint;
  await assertSigner(
    owner,
    recoverTypedDataAddress({
      domain: stablecoinDomain(chain),
      types: TYPES.Permit,
      primaryType: "Permit",
      message: { owner, spender, value, nonce, deadline: permitDeadline },
      signature: sig,
    }),
    "permit",
  );
  return { permit: { value, deadline: permitDeadline, ...vrs(sig) }, sig };
}

/* ── Checkout: pay now, pay in 4, subscribe ─────────────────────────────── */

async function pay(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const replayed = await replay("pay", relayIdOf("pay", signature(body, "signature")));
  if (replayed) return replayed;
  const { session, merchant } = await openSessionForPayment(body.sessionId);
  if (!session.modes.includes("now")) throw new HttpError(400, "mode_not_offered", "This checkout doesn't offer paying in full.");
  const buyer = address(body, "buyer");
  const validAfter = uint(body, "validAfter");
  const validBefore = deadline(uint(body, "validBefore"), "validBefore");
  const sig = signature(body, "signature");
  const amount = centsToUnits(session.amountCents);
  if (body.amount !== undefined && uint(body, "amount") !== amount) throw new HttpError(400, "wrong_amount", "The price changed. Open the checkout again.", { param: "amount" });
  const nonce = orderKeyOf(session.chain.merchant, session.chain.orderId);

  await assertSigner(
    buyer,
    recoverTypedDataAddress({
      domain: stablecoinDomain(chain),
      types: TYPES.ReceiveWithAuthorization,
      primaryType: "ReceiveWithAuthorization",
      message: { from: buyer, to: chain.contracts.payments, value: amount, validAfter, validBefore, nonce },
      signature: sig,
    }),
    "payment",
  );
  countVerified(buyer);
  const { v, r, s } = vrs(sig);
  const relayId = relayIdOf("pay", sig);
  await assertNothingInFlight(session.id, relayId);
  await ensureQuoted(session, merchant);
  const result = await carry({
    kind: "pay",
    relayId,
    to: chain.contracts.checkout,
    data: encodeFunctionData({
      abi: polarisCheckoutAbi,
      functionName: "pay",
      args: [buyer, session.chain.merchant, amount, session.chain.orderId, validAfter, validBefore, v, r, s],
    }),
    signer: buyer,
    sessionId: session.id,
    merchantId: merchant.id,
  });
  return respond("pay", { ...result, ids: { paymentId: nonce, orderKey: nonce, ...result.ids } }, session.id);
}

async function openPlan(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const config = getConfig();
  const replayed = await replay("openPlan", relayIdOf("openPlan", signature(body, "signature"), body.permit ? signature(body, "permit.signature") : "0x"));
  if (replayed) return replayed;
  const { session, merchant } = await openSessionForPayment(body.sessionId);
  if (!session.modes.includes("later")) throw new HttpError(400, "mode_not_offered", "This checkout doesn't offer Pay in 4.");
  if (session.amountCents < config.payIn4.minCents || session.amountCents > config.payIn4.maxCents) {
    throw new HttpError(400, "mode_not_offered", "Pay in 4 isn't available for this amount.");
  }
  const buyer = address(body, "intent.buyer");
  const principal = uint(body, "intent.principal");
  const installments = Number(uint(body, "intent.installments", { max: 0xffffffffn }));
  const interval = uint(body, "intent.interval", { max: 0xffffffffffffffffn });
  const nonce = uint(body, "intent.nonce");
  const intentDeadline = deadline(uint(body, "intent.deadline"), "intent.deadline", { maxAheadSeconds: 3600 });
  const sig = signature(body, "signature");

  if (principal !== centsToUnits(session.amountCents)) throw new HttpError(400, "wrong_amount", "The price changed. Open the checkout again.", { param: "intent.principal" });
  if (installments !== config.payIn4.installments || interval !== BigInt(config.payIn4.intervalSeconds)) {
    throw new HttpError(400, "invalid_plan", "That payment schedule isn't the one this checkout offers.", { param: "intent.installments" });
  }

  const intent = {
    buyer,
    merchant: session.chain.merchant,
    principal,
    installments,
    interval,
    orderId: session.chain.orderId,
    nonce,
    deadline: intentDeadline,
  };
  await assertSigner(
    buyer,
    recoverTypedDataAddress({ domain: polarisDomain("checkout", chain.id, chain.contracts.checkout), types: TYPES.PlanIntent, primaryType: "PlanIntent", message: intent, signature: sig }),
    "plan",
  );
  const { permit, sig: permitSig } = await permitOf(body, buyer, chain.contracts.loanEngine, chain);
  countVerified(buyer);
  const relayId = relayIdOf("openPlan", sig, permitSig ?? "0x");
  await assertNothingInFlight(session.id, relayId);
  await ensureQuoted(session, merchant);
  const result = await carry({
    kind: "openPlan",
    relayId,
    to: chain.contracts.checkout,
    data: encodeFunctionData({ abi: polarisCheckoutAbi, functionName: "openPlan", args: [intent, sig, permit] }),
    signer: buyer,
    sessionId: session.id,
    merchantId: merchant.id,
  });
  return respond("openPlan", result, session.id);
}

async function subscribe(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const replayed = await replay("subscribe", relayIdOf("subscribe", signature(body, "signature"), body.permit ? signature(body, "permit.signature") : "0x"));
  if (replayed) return replayed;
  const { session, merchant } = await openSessionForPayment(body.sessionId);
  if (!session.modes.includes("subscribe") || !session.subscription) throw new HttpError(400, "mode_not_offered", "This checkout doesn't offer a subscription.");
  if (!session.chain.subscriptionPlanId) throw new HttpError(409, "plan_not_ready", "This subscription is still being set up. Try again in a moment.");
  const buyer = address(body, "intent.buyer");
  const planId = uint(body, "intent.planId");
  const pricePerPeriod = uint(body, "intent.pricePerPeriod");
  const period = uint(body, "intent.periodSeconds", { max: 0xffffffffffffffffn });
  const nonce = uint(body, "intent.nonce");
  const intentDeadline = deadline(uint(body, "intent.deadline"), "intent.deadline", { maxAheadSeconds: 3600 });
  const sig = signature(body, "signature");

  if (planId.toString() !== session.chain.subscriptionPlanId) throw new HttpError(400, "plan_mismatch", "The subscription's terms changed. Open the checkout again.", { param: "intent.planId" });
  if (pricePerPeriod !== centsToUnits(session.amountCents) || period !== BigInt(periodSeconds(session.subscription))) {
    throw new HttpError(400, "plan_mismatch", "The subscription's terms changed. Open the checkout again.", { param: "intent.pricePerPeriod" });
  }
  const intent = {
    buyer,
    merchant: session.chain.merchant,
    planId,
    pricePerPeriod,
    periodSeconds: period,
    orderId: session.chain.orderId,
    nonce,
    deadline: intentDeadline,
  };
  await assertSigner(
    buyer,
    recoverTypedDataAddress({
      domain: polarisDomain("checkout", chain.id, chain.contracts.checkout),
      types: TYPES.SubscribeIntent,
      primaryType: "SubscribeIntent",
      message: intent,
      signature: sig,
    }),
    "subscription",
  );
  const { permit, sig: permitSig } = await permitOf(body, buyer, chain.contracts.payments, chain);
  countVerified(buyer);
  const relayId = relayIdOf("subscribe", sig, permitSig ?? "0x");
  await assertNothingInFlight(session.id, relayId);
  await ensureQuoted(session, merchant);
  const result = await carry({
    kind: "subscribe",
    relayId,
    to: chain.contracts.checkout,
    data: encodeFunctionData({ abi: polarisCheckoutAbi, functionName: "subscribe", args: [intent, sig, permit] }),
    signer: buyer,
    sessionId: session.id,
    merchantId: merchant.id,
  });
  return respond("subscribe", result, session.id);
}

/* ── Send by link ───────────────────────────────────────────────────────── */

/** PolarisSend: `keccak256(abi.encode(linkKey, expiresAt))`. */
export function sendNonce(linkKey: Address, expiresAt: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [linkKey, expiresAt]));
}

async function send(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const sender = address(body, "sender");
  const linkKey = address(body, "linkKey");
  const amount = uint(body, "amount");
  if (amount === 0n) bad("amount", "amount must be more than zero.");
  assertMinimum(amount, "amount");
  const expiresAt = uint(body, "expiresAt", { max: 0xffffffffffffffffn });
  if (expiresAt <= BigInt(now())) bad("expiresAt", "expiresAt must be in the future.");
  const validAfter = uint(body, "validAfter");
  const validBefore = deadline(uint(body, "validBefore"), "validBefore", { maxAheadSeconds: 3600 });
  const sig = signature(body, "signature");
  const linkSig = signature(body, "linkSignature");

  await assertSigner(
    sender,
    recoverTypedDataAddress({
      domain: stablecoinDomain(chain),
      types: TYPES.ReceiveWithAuthorization,
      primaryType: "ReceiveWithAuthorization",
      message: { from: sender, to: chain.contracts.send, value: amount, validAfter, validBefore, nonce: sendNonce(linkKey, expiresAt) },
      signature: sig,
    }),
    "send",
  );
  await assertSigner(
    linkKey,
    recoverTypedDataAddress({
      domain: polarisDomain("send", chain.id, chain.contracts.send),
      types: TYPES.Open,
      primaryType: "Open",
      message: { sender, amount, expiresAt },
      signature: linkSig,
    }),
    "link",
  );
  countVerified(sender, { open: true });
  const a = vrs(sig);
  const k = vrs(linkSig);
  const result = await carry({
    kind: "send",
    relayId: relayIdOf("send", sig, linkSig),
    to: chain.contracts.send,
    data: encodeFunctionData({
      abi: polarisSendAbi,
      functionName: "send",
      args: [sender, linkKey, amount, expiresAt, validAfter, validBefore, a.v, a.r, a.s, k.v, k.r, k.s],
    }),
    signer: sender,
  });
  return respond("send", result, null);
}

async function claim(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const linkKey = address(body, "linkKey");
  const to = address(body, "to");
  const claimDeadline = deadline(uint(body, "deadline"), "deadline", { maxAheadSeconds: 3600 });
  const sig = signature(body, "signature");
  await assertSigner(
    linkKey,
    recoverTypedDataAddress({
      domain: polarisDomain("send", chain.id, chain.contracts.send),
      types: TYPES.Claim,
      primaryType: "Claim",
      message: { to, deadline: claimDeadline },
      signature: sig,
    }),
    "claim",
  );
  countVerified(linkKey, { open: true });
  const { v, r, s } = vrs(sig);
  const result = await carry({
    kind: "claim",
    relayId: relayIdOf("claim", sig),
    to: chain.contracts.send,
    data: encodeFunctionData({ abi: polarisSendAbi, functionName: "claim", args: [linkKey, to, claimDeadline, v, r, s] }),
    signer: linkKey,
  });
  return respond("claim", result, null);
}

async function cancelSend(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const linkKey = address(body, "linkKey");
  const cancelDeadline = deadline(uint(body, "deadline"), "deadline", { maxAheadSeconds: 3600 });
  const sig = signature(body, "signature");
  const link = (await publicClient().readContract({ address: chain.contracts.send, abi: polarisSendAbi, functionName: "linkOf", args: [linkKey] })) as { sender: Address };
  if (!link.sender || getAddress(link.sender) === "0x0000000000000000000000000000000000000000") {
    throw new HttpError(404, "link_not_found", "This link has already been claimed or cancelled.");
  }
  await assertSigner(
    link.sender,
    recoverTypedDataAddress({
      domain: polarisDomain("send", chain.id, chain.contracts.send),
      types: TYPES.Cancel,
      primaryType: "Cancel",
      message: { linkKey, deadline: cancelDeadline },
      signature: sig,
    }),
    "cancel",
  );
  countVerified(link.sender, { open: true });
  const { v, r, s } = vrs(sig);
  const result = await carry({
    kind: "cancelSend",
    relayId: relayIdOf("cancelSend", sig),
    to: chain.contracts.send,
    data: encodeFunctionData({ abi: polarisSendAbi, functionName: "cancel", args: [linkKey, cancelDeadline, v, r, s] }),
    signer: link.sender,
  });
  return respond("cancelSend", result, null);
}

/* ── Plans and subscriptions after checkout ─────────────────────────────── */

async function repay(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const loanId = uint(body, "loanId");
  const amount = uint(body, "amount");
  if (amount === 0n) bad("amount", "amount must be more than zero.");
  const expectedRepaid = uint(body, "expectedRepaid");
  const repayDeadline = deadline(uint(body, "deadline"), "deadline", { maxAheadSeconds: 3600 });
  const sig = signature(body, "signature");
  const client = publicClient();
  const loan = (await client.readContract({ address: chain.contracts.loanEngine, abi: polarisLoanEngineAbi, functionName: "getLoan", args: [loanId] })) as { borrower: Address };
  if (!loan.borrower || /^0x0{40}$/i.test(loan.borrower)) throw new HttpError(404, "plan_not_found", "We couldn't find that plan.");
  const nonce = (await client.readContract({ address: chain.contracts.loanEngine, abi: polarisLoanEngineAbi, functionName: "nonces", args: [loan.borrower] })) as bigint;
  await assertSigner(
    loan.borrower,
    recoverTypedDataAddress({
      domain: polarisDomain("loanEngine", chain.id, chain.contracts.loanEngine),
      types: TYPES.RepayIntent,
      primaryType: "RepayIntent",
      message: { loanId, amount, expectedRepaid, nonce, deadline: repayDeadline },
      signature: sig,
    }),
    "repayment",
  );
  countVerified(loan.borrower);
  const result = await carry({
    kind: "repay",
    relayId: relayIdOf("repay", sig),
    to: chain.contracts.loanEngine,
    data: encodeFunctionData({ abi: polarisLoanEngineAbi, functionName: "repayWithSig", args: [loanId, amount, expectedRepaid, repayDeadline, sig] }),
    signer: loan.borrower,
  });
  return respond("repay", { ...result, ids: { planId: loanId.toString(), ...result.ids } }, null);
}

/**
 * A buyer whose instalment failed because the loan engine's allowance was
 * gone (a collections run skipped it with InsufficientAllowance) signs one
 * ERC-2612 permit again: spender PolarisLoanEngine, value at least everything
 * they owe it (a permit replaces the allowance). PolarisCheckout.reauthorize
 * applies it and emits Reauthorized, and the CRE collections workflow's EVM
 * log trigger collects what is due in the same minute
 * (CollectionsReceiver.dueTasksFor). Refused before any gas when nothing is
 * owed, when the allowance already covers it, or when the permit is short.
 */
async function reauthorize(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  if (body.permit === undefined || body.permit === null) bad("permit", "permit is required.");
  const replayed = await replay("reauthorize", relayIdOf("reauthorize", signature(body, "permit.signature")));
  if (replayed) return replayed;
  const buyer = address(body, "buyer");
  const client = publicClient();
  const [owed, allowance] = await Promise.all([
    client.readContract({ address: chain.contracts.loanEngine, abi: polarisLoanEngineAbi, functionName: "activeDebtOf", args: [buyer] }) as Promise<bigint>,
    client.readContract({ address: chain.contracts.stablecoin, abi: iausdAbi, functionName: "allowance", args: [buyer, chain.contracts.loanEngine] }) as Promise<bigint>,
  ]);
  if (owed === 0n) throw new HttpError(409, "nothing_owed", "You don't owe anything on Pay in 4 right now.");
  if (allowance >= owed) throw new HttpError(409, "already_authorised", "Your payments are already set up. Each one is collected on its date.");
  const { permit, sig } = await permitOf(body, buyer, chain.contracts.loanEngine, chain);
  if (permit.value < owed) {
    throw new HttpError(409, "stale_signature", "What you owe changed since you confirmed. Try again.", { param: "permit.value" });
  }
  countVerified(buyer);
  const result = await carry({
    kind: "reauthorize",
    relayId: relayIdOf("reauthorize", sig as Hex),
    to: chain.contracts.checkout,
    data: encodeFunctionData({ abi: polarisCheckoutAbi, functionName: "reauthorize", args: [buyer, permit] }),
    signer: buyer,
  });
  return respond("reauthorize", result, null);
}

/**
 * A secured Pay in 4 line with no MON: the borrower signs one ERC-2612 permit
 * (spender CollateralVault, value the amount) and the relayer sends
 * CollateralVault.lockWithPermit, which locks it into the borrower's own
 * position (it can move it nowhere else). ScoreManager counts it toward the
 * borrower's limit at once. Refused before any gas when the deployment's
 * vault can't take a permit, below the relayer's minimum, when the borrower
 * doesn't hold the amount, or when the permit isn't theirs.
 */
async function lockCollateral(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const vault = chain.contracts.vault;
  if (!vault) throw new HttpError(409, "collateral_unavailable", "Securing a limit with collateral isn't available on this network.");
  if (body.permit === undefined || body.permit === null) bad("permit", "permit is required.");
  const replayed = await replay("lockCollateral", relayIdOf("lockCollateral", signature(body, "permit.signature")));
  if (replayed) return replayed;
  const borrower = address(body, "borrower");
  const amount = uint(body, "amount");
  if (amount === 0n) bad("amount", "amount must be more than zero.");
  assertMinimum(amount, "amount");
  const { permit, sig } = await permitOf(body, borrower, vault, chain);
  if (permit.value !== amount) {
    throw new HttpError(400, "wrong_amount", "The amount you confirmed isn't the amount to lock. Try again.", { param: "permit.value" });
  }
  const balance = (await publicClient().readContract({ address: chain.contracts.stablecoin, abi: iausdAbi, functionName: "balanceOf", args: [borrower] })) as bigint;
  if (balance < amount) throw new HttpError(409, "insufficient_balance", "You don't have that much to set aside right now.", { param: "amount" });
  countVerified(borrower, { open: true });
  const result = await carry({
    kind: "lockCollateral",
    relayId: relayIdOf("lockCollateral", sig as Hex),
    to: vault,
    data: encodeFunctionData({
      abi: collateralVaultAbi,
      functionName: "lockWithPermit",
      args: [borrower, amount, permit.deadline, permit.v, permit.r, permit.s],
    }),
    signer: borrower,
  });
  return respond("lockCollateral", result, null);
}

/**
 * Take out of Boost with no MON: the borrower signs CollateralVault's EIP-712
 * `Withdraw` (borrower, amount, the vault's `nonces(borrower)`, a deadline
 * within the hour) and the relayer sends `withdrawWithSig`, which pays the
 * borrower and nobody else, under `withdraw`'s own rules. Refused before any
 * gas when the network's vault predates signed withdrawal (Monad testnet's
 * today: "not available on this network yet"), below the relayer's minimum,
 * when it would strand less than the minimum in Boost, when the signature
 * isn't the borrower's, when it's more than they have in Boost, or while
 * their Boost secures a Pay in 4 plan (the vault releases nothing while any
 * debt is outstanding).
 */
async function withdrawCollateral(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const vault = chain.contracts.vault;
  if (!vault) throw new HttpError(409, "collateral_unavailable", "Boost isn't available on this network.");
  const sig = signature(body, "signature");
  const replayed = await replay("withdrawCollateral", relayIdOf("withdrawCollateral", sig));
  if (replayed) return replayed;
  const domain = await vaultWithdrawDomain(chain);
  if (!domain) throw new HttpError(409, "withdraw_unavailable", "Taking dollars out of Boost isn't available on this network yet. They stay yours, in Boost.");
  const borrower = address(body, "borrower");
  const amount = uint(body, "amount");
  if (amount === 0n) bad("amount", "amount must be more than zero.");
  assertMinimum(amount, "amount");
  const withdrawDeadline = deadline(uint(body, "deadline"), "deadline", { maxAheadSeconds: 3600 });
  const client = publicClient();
  const [nonce, locked, free] = await Promise.all([
    client.readContract({ address: vault, abi: collateralVaultAbi, functionName: "nonces", args: [borrower] }) as Promise<bigint>,
    client.readContract({ address: vault, abi: collateralVaultAbi, functionName: "lockedOf", args: [borrower] }) as Promise<bigint>,
    client.readContract({ address: vault, abi: collateralVaultAbi, functionName: "withdrawable", args: [borrower] }) as Promise<bigint>,
  ]);
  await assertSigner(
    borrower,
    recoverTypedDataAddress({
      domain,
      types: TYPES.Withdraw,
      primaryType: "Withdraw",
      message: { borrower, amount, nonce, deadline: withdrawDeadline },
      signature: sig,
    }),
    "take out",
  );
  if (amount > locked) throw new HttpError(409, "insufficient_collateral", "That's more than you have in Boost.", { param: "amount" });
  if (amount > free) {
    throw new HttpError(409, "collateral_in_use", "Your Boost secures a Pay in 4 plan, so it stays in until the plan is paid off.", { param: "amount" });
  }
  const left = locked - amount;
  const min = getConfig().relayerLimits.minTransferUnits;
  if (left > 0n && left < min) {
    bad("amount", `That would leave less than ${formatUnits(min)} AUSD in Boost. Take it all out, or leave more.`);
  }
  countVerified(borrower, { open: true });
  const result = await carry({
    kind: "withdrawCollateral",
    relayId: relayIdOf("withdrawCollateral", sig),
    to: vault,
    data: encodeFunctionData({ abi: collateralVaultAbi, functionName: "withdrawWithSig", args: [borrower, amount, withdrawDeadline, sig] }),
    signer: borrower,
  });
  return respond("withdrawCollateral", result, null);
}

async function cancelSubscription(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const subId = uint(body, "subId");
  const cancelDeadline = deadline(uint(body, "deadline"), "deadline", { maxAheadSeconds: 3600 });
  const sig = signature(body, "signature");
  const sub = (await publicClient().readContract({ address: chain.contracts.payments, abi: polarisPaymentsAbi, functionName: "getSubscription", args: [subId] })) as {
    subscriber: Address;
  };
  if (!sub.subscriber || /^0x0{40}$/i.test(sub.subscriber)) throw new HttpError(404, "subscription_not_found", "We couldn't find that subscription.");
  await assertSigner(
    sub.subscriber,
    recoverTypedDataAddress({
      domain: polarisDomain("payments", chain.id, chain.contracts.payments),
      types: TYPES.CancelSubscription,
      primaryType: "CancelSubscription",
      message: { subId, deadline: cancelDeadline },
      signature: sig,
    }),
    "cancellation",
  );
  countVerified(sub.subscriber);
  const { v, r, s } = vrs(sig);
  const result = await carry({
    kind: "cancelSubscription",
    relayId: relayIdOf("cancelSubscription", sig),
    to: chain.contracts.payments,
    data: encodeFunctionData({ abi: polarisPaymentsAbi, functionName: "cancelWithSignature", args: [subId, cancelDeadline, v, r, s] }),
    signer: sub.subscriber,
  });
  return respond("cancelSubscription", { ...result, ids: { subscriptionId: subId.toString(), ...result.ids } }, null);
}

/* ── Transfers: to another account, withdrawals, payouts ────────────────── */

export async function relayTransfer(input: {
  chain: ChainConfig;
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
  kind?: "transfer" | "payout";
  merchantId?: string | null;
}): Promise<RelayResult> {
  const { chain } = input;
  if (input.value === 0n) bad("value", "value must be more than zero.");
  if (getAddress(input.from) === getAddress(input.to)) bad("to", "to must be another account than from.");
  await assertSigner(
    input.from,
    recoverTypedDataAddress({
      domain: stablecoinDomain(chain),
      types: TYPES.TransferWithAuthorization,
      primaryType: "TransferWithAuthorization",
      message: { from: input.from, to: input.to, value: input.value, validAfter: input.validAfter, validBefore: input.validBefore, nonce: input.nonce },
      signature: input.signature,
    }),
    "transfer",
  );
  countVerified(input.from, { open: (input.kind ?? "transfer") === "transfer" });
  const { v, r, s } = vrs(input.signature);
  return carry({
    kind: input.kind ?? "transfer",
    relayId: relayIdOf("transfer", input.signature),
    to: chain.contracts.stablecoin,
    data: encodeFunctionData({
      abi: iausdAbi,
      functionName: "transferWithAuthorization",
      args: [input.from, input.to, input.value, input.validAfter, input.validBefore, input.nonce, v, r, s],
    }),
    signer: input.from,
    merchantId: input.merchantId ?? null,
  });
}

async function transfer(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const from = address(body, "from");
  const value = uint(body, "value");
  assertMinimum(value, "value");
  const result = await relayTransfer({
    chain,
    from,
    to: address(body, "to"),
    value,
    validAfter: uint(body, "validAfter"),
    validBefore: deadline(uint(body, "validBefore"), "validBefore"),
    nonce: bytes32(body, "nonce"),
    signature: signature(body, "signature"),
  });
  return respond("transfer", result, null);
}

/* ── Split the bill (PolarisSplit) ──────────────────────────────────────── */

const UINT128_MAX = (1n << 128n) - 1n;

/**
 * The organiser opens a split: their CreateSplit signature over the shares,
 * the salt the split's id comes from, the hash of the link's words and the
 * expiry. The words themselves never come here. Every share must be at least
 * the relayer's minimum, like a send by link, so a split can't be used to
 * make the relayer carry dust between throwaway accounts.
 */
async function createSplit(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const split = requireSplitContract(chain);
  const sig = signature(body, "signature");
  const replayed = await replay("createSplit", relayIdOf("createSplit", sig));
  if (replayed) return replayed;
  const organiser = address(body, "creation.organiser");
  const salt = bytes32(body, "creation.salt");
  const raw = field(body, "creation.amounts");
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SHARES) bad("creation.amounts", `creation.amounts must list 1 to ${MAX_SHARES} shares.`);
  const amounts = raw.map((_, i) => uint(body, `creation.amounts.${i}`, { max: UINT128_MAX }));
  amounts.forEach((amount, i) => assertMinimum(amount, `creation.amounts.${i}`));
  if (amounts.reduce((sum, a) => sum + a, 0n) > UINT128_MAX) bad("creation.amounts", "The shares add up to too much.");
  const memoHash = bytes32(body, "creation.memoHash");
  const expiresAt = uint(body, "creation.expiresAt", { max: 0xffffffffffffffffn });
  const t = BigInt(now());
  if (expiresAt < t + BigInt(SPLIT_MIN_LIFETIME) + 60n || expiresAt > t + BigInt(SPLIT_MAX_EXPIRY)) {
    bad("creation.expiresAt", "A split stays open from a few minutes to 60 days.");
  }
  const createDeadline = deadline(uint(body, "creation.deadline"), "creation.deadline", { maxAheadSeconds: 3600 });
  const creation = { organiser, salt, amounts, memoHash, expiresAt, deadline: createDeadline };
  await assertSigner(
    organiser,
    recoverTypedDataAddress({ domain: polarisDomain("split", chain.id, split), types: TYPES.CreateSplit, primaryType: "CreateSplit", message: creation, signature: sig }),
    "split",
  );
  const splitId = splitIdOf(organiser, salt);
  if (await readSplit(splitId, chain)) throw new HttpError(409, "split_exists", "This split is already open.");
  countVerified(organiser, { open: true });
  const result = await carry({
    kind: "createSplit",
    relayId: relayIdOf("createSplit", sig),
    to: split,
    data: encodeFunctionData({ abi: polarisSplitAbi, functionName: "createSplit", args: [creation, sig] }),
    signer: organiser,
  });
  return respond("createSplit", { ...result, ids: { splitId, ...result.ids } }, null);
}

/**
 * A friend pays their share: an ERC-3009 ReceiveWithAuthorization from them,
 * payable to PolarisSplit, for exactly the share's amount (read from the
 * chain, never taken from the request), with the nonce PolarisSplit derives
 * from the split and the share. Refused before any gas when the split is
 * closed, expired or the share already paid.
 */
async function payShare(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const split = requireSplitContract(chain);
  const sig = signature(body, "signature");
  const replayed = await replay("payShare", relayIdOf("payShare", sig));
  if (replayed) return replayed;
  const splitId = bytes32(body, "splitId");
  const index = uint(body, "index", { max: BigInt(MAX_SHARES - 1) });
  const payer = address(body, "payer");
  const validAfter = uint(body, "validAfter");
  const validBefore = deadline(uint(body, "validBefore"), "validBefore", { maxAheadSeconds: 3600 });
  const state = await readSplit(splitId, chain);
  if (!state) throw new HttpError(404, "split_not_found", "We couldn't find that split.");
  if (state.closed) throw new HttpError(409, "split_closed", "This split was closed, so it can't be paid any more. Nothing was charged.");
  if (now() >= state.expiresAt) throw new HttpError(410, "split_expired", "This split has expired. Nothing was charged.");
  if (index >= BigInt(state.amounts.length)) bad("index", "That share isn't part of this split.");
  if (state.payers[Number(index)]) throw new HttpError(409, "already_paid", "This share has already been paid.", { param: "index" });
  const amount = state.amounts[Number(index)] as bigint;
  if (body.amount !== undefined && uint(body, "amount") !== amount) throw new HttpError(400, "wrong_amount", "The share changed. Open the link again.", { param: "amount" });

  await assertSigner(
    payer,
    recoverTypedDataAddress({
      domain: stablecoinDomain(chain),
      types: TYPES.ReceiveWithAuthorization,
      primaryType: "ReceiveWithAuthorization",
      message: { from: payer, to: split, value: amount, validAfter, validBefore, nonce: shareNonce(splitId, index) },
      signature: sig,
    }),
    "share",
  );
  countVerified(payer, { open: true });
  const { v, r, s } = vrs(sig);
  const result = await carry({
    kind: "payShare",
    relayId: relayIdOf("payShare", sig),
    to: split,
    data: encodeFunctionData({ abi: polarisSplitAbi, functionName: "payShare", args: [splitId, index, payer, validAfter, validBefore, v, r, s] }),
    signer: payer,
  });
  return respond("payShare", { ...result, ids: { splitId, shareIndex: index.toString(), ...result.ids } }, null);
}

/** The organiser closes a split: their CloseSplit signature. Nothing moves; unpaid shares can't be paid after. */
async function closeSplit(body: Record<string, unknown>, chain: ChainConfig): Promise<RelayResponse> {
  const split = requireSplitContract(chain);
  const sig = signature(body, "signature");
  const replayed = await replay("closeSplit", relayIdOf("closeSplit", sig));
  if (replayed) return replayed;
  const splitId = bytes32(body, "splitId");
  const closeDeadline = deadline(uint(body, "deadline"), "deadline", { maxAheadSeconds: 3600 });
  const state = await readSplit(splitId, chain);
  if (!state) throw new HttpError(404, "split_not_found", "We couldn't find that split.");
  if (state.closed) throw new HttpError(409, "split_closed", "This split is already closed.");
  await assertSigner(
    state.organiser,
    recoverTypedDataAddress({ domain: polarisDomain("split", chain.id, split), types: TYPES.CloseSplit, primaryType: "CloseSplit", message: { splitId, deadline: closeDeadline }, signature: sig }),
    "close",
  );
  countVerified(state.organiser, { open: true });
  const result = await carry({
    kind: "closeSplit",
    relayId: relayIdOf("closeSplit", sig),
    to: split,
    data: encodeFunctionData({ abi: polarisSplitAbi, functionName: "closeSplit", args: [splitId, closeDeadline, sig] }),
    signer: state.organiser,
  });
  return respond("closeSplit", { ...result, ids: { splitId, ...result.ids } }, null);
}

/* ── Entry points ───────────────────────────────────────────────────────── */

export async function handleRelay(body: Record<string, unknown>): Promise<RelayResponse> {
  const chain = requireChain();
  const type = body.type;
  if (typeof type !== "string" || !(RELAY_TYPES as readonly string[]).includes(type)) {
    bad("type", `type must be one of ${RELAY_TYPES.join(", ")}.`);
  }
  if (body.chainId !== undefined && Number(body.chainId) !== chain.id) {
    throw new HttpError(400, "wrong_chain", `This relayer carries chain ${chain.id} only.`, { param: "chainId" });
  }
  switch (type as RelayType) {
    case "pay":
      return pay(body, chain);
    case "openPlan":
      return openPlan(body, chain);
    case "subscribe":
      return subscribe(body, chain);
    case "send":
      return send(body, chain);
    case "claim":
      return claim(body, chain);
    case "cancelSend":
      return cancelSend(body, chain);
    case "repay":
      return repay(body, chain);
    case "reauthorize":
      return reauthorize(body, chain);
    case "lockCollateral":
      return lockCollateral(body, chain);
    case "withdrawCollateral":
      return withdrawCollateral(body, chain);
    case "cancelSubscription":
      return cancelSubscription(body, chain);
    case "transfer":
      return transfer(body, chain);
    case "createSplit":
      return createSplit(body, chain);
    case "payShare":
      return payShare(body, chain);
    case "closeSplit":
      return closeSplit(body, chain);
  }
}

/**
 * `POST /api/v1/relay/payments`: polarispay-sdk's `pay()` with a `relayUrl`.
 * Exactly the SDK's contract (packages/sdk README, "Relay"): refuse any other
 * contract or chain, recompute the nonce, and submit
 * `PolarisPayments.payWithAuthorization`. The publishable key names the
 * merchant, so the relayer only carries payments to that merchant.
 */
export async function handleSdkRelay(merchant: MerchantRecord, body: Record<string, unknown>): Promise<{ txHash: Hex; status: "submitted" | "confirmed"; paymentId: Hex }> {
  const chain = requireChain();
  if (body.type !== "payWithAuthorization") bad("type", 'type must be "payWithAuthorization".');
  if (Number(body.chainId) !== chain.id) throw new HttpError(400, "wrong_chain", `This relayer carries chain ${chain.id} only.`, { param: "chainId" });
  const contract = address(body, "contract");
  if (contract !== chain.contracts.payments) throw new HttpError(400, "wrong_contract", "The relayer only calls PolarisPayments here.", { param: "contract" });
  const payer = address(body, "payer");
  const merchantAddress = address(body, "merchant");
  if (!merchant.walletAddress || merchantAddress !== merchant.walletAddress) {
    throw new HttpError(403, "wrong_merchant", "This key can only take payments to its own business.", { param: "merchant" });
  }
  const amount = uint(body, "amount");
  if (amount === 0n) bad("amount", "amount must be more than zero.");
  const orderId = text(body, "orderId");
  const validAfter = uint(body, "validAfter");
  const validBefore = deadline(uint(body, "validBefore"), "validBefore");
  const sig = signature(body, "signature");
  const nonce = orderKeyOf(merchantAddress, orderId);
  if (body.nonce !== undefined && bytes32(body, "nonce") !== nonce.toLowerCase()) {
    throw new HttpError(400, "wrong_nonce", "nonce must be keccak256(abi.encodePacked(merchant, orderId)).", { param: "nonce" });
  }
  // A checkout session's order is paid through that checkout, at the session's price, never here:
  // its id is public, and this path takes any amount the payer signs.
  if (await getDb().sessions.findOne({ orderKey: nonce.toLowerCase() })) {
    throw new HttpError(409, "order_is_a_checkout", "This order belongs to a Polaris checkout session: pay it through that checkout.", { param: "orderId" });
  }
  // PolarisPayments can't see an order PolarisCheckout settled as Pay in 4 or a subscription (the checkout's
  // cross-mode guard only runs on its own entry points), so check it here rather than charge a buyer twice.
  const settled = (await publicClient().readContract({ address: chain.contracts.checkout, abi: polarisCheckoutAbi, functionName: "orders", args: [nonce] })) as
    | readonly [number, bigint, Address, bigint, bigint]
    | { kind: number };
  const kind = Array.isArray(settled) ? Number(settled[0]) : Number((settled as { kind: number }).kind);
  if (kind !== 0) throw new HttpError(409, "already_paid", "This has already been paid.", { param: "orderId" });
  await assertSigner(
    payer,
    recoverTypedDataAddress({
      domain: stablecoinDomain(chain),
      types: TYPES.ReceiveWithAuthorization,
      primaryType: "ReceiveWithAuthorization",
      message: { from: payer, to: chain.contracts.payments, value: amount, validAfter, validBefore, nonce },
      signature: sig,
    }),
    "payment",
  );
  countVerified(payer);
  const { v, r, s } = vrs(sig);
  const result = await carry({
    kind: "payWithAuthorization",
    relayId: relayIdOf("payWithAuthorization", sig),
    to: chain.contracts.payments,
    data: encodeFunctionData({
      abi: polarisPaymentsAbi,
      functionName: "payWithAuthorization",
      args: [payer, merchantAddress, amount, orderId, validAfter, validBefore, v, r, s],
    }),
    signer: payer,
    merchantId: merchant.id,
  });
  return { txHash: result.txHash, status: result.status, paymentId: nonce };
}

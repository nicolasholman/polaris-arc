import type { Address, Hex, TypedDataDomain } from "viem";
import { ApiError, api } from "./api";
import { lockCollateralBody, withdrawCollateralBody } from "./boost";
import { receiptUrl } from "./chain";
import { notifyDataChanged } from "./data/changes";
import type { PaymentLink, Person } from "./data/types";
import type { Micros } from "./money";
import type { Authorization, Cancel, CancelSubscription, Claim, CloseSplit, CreateSplit, Open, Permit, PlanIntent, RepayIntent, SubscribeIntent, Withdraw } from "./sign";

/**
 * The relayer carries signatures to the chain (plan §5.3). The app signs; the
 * relayer, a policy-locked Privy server wallet run by Polaris for Business,
 * checks each signature, simulates the call and sends it, paying the gas. The
 * app never sends a transaction and the buyer never holds MON.
 *
 * With `NEXT_PUBLIC_POLARIS_API_URL` set, every request goes to
 * `POST {api}/api/relay` (apps/business/src/server/relayer/relay.ts has the
 * request shapes) and "Paid" comes from the transaction's own events, which
 * the server reads from the receipt. There is no other relayer: a build
 * without the API refuses before anything is signed (`domains.ts`), and a
 * request that got here anyway fails with "not configured".
 */

export type Signed<T> = { message: T; signature: Hex; domain: TypedDataDomain };

export type RelayReceipt = {
  txHash: Hex;
  /** When the relayer submitted and when the block was final. */
  submittedAt: number;
  finalizedAt: number;
  /**
   * The explorer page; the only way the buyer ever reaches it is "View
   * receipt". Null on a local chain, which has no explorer.
   */
  explorerUrl: string | null;
  /** From the transaction's events, when the relayer saw them. */
  paymentId?: string;
  planId?: string;
  subscriptionId?: string;
  splitId?: string;
  shareIndex?: string;
};

/** PolarisCheckout.pay */
export type PayNowRequest = { link: PaymentLink; payer: Address; authorization: Signed<Authorization> };

/** PolarisCheckout.openPlan: two signatures, one Confirm. */
export type OpenPlanRequest = { link: PaymentLink; intent: Signed<PlanIntent>; permit: Signed<Permit> };

/** PolarisCheckout.subscribe */
export type SubscribeRequest = { link: PaymentLink; intent: Signed<SubscribeIntent>; permit: Signed<Permit> };

/** PolarisSend.send: the sender's authorisation, and the link key's Open. */
export type SendRequest = {
  sender: Address;
  senderName: string;
  linkKey: Address;
  amount: Micros;
  expiresAt: bigint;
  authorization: Signed<Authorization>;
  open: Signed<Open>;
};

/** PolarisSend.claim(linkKey, to, deadline, v, r, s): signed by the link's key, naming the recipient. */
export type ClaimRequest = {
  linkKey: Address;
  claim: Signed<Claim>;
  /** The same deadline the claim signs; PolarisSend takes it as its own argument. */
  deadline: bigint;
  /** Display only, from the link. The chain pays what was escrowed. */
  amount: Micros;
  senderName: string;
};

/** PolarisSend.cancel */
export type CancelSendRequest = { cancel: Signed<Cancel> };

/** PolarisPayments.cancelWithSignature */
export type CancelSubscriptionRequest = { cancel: Signed<CancelSubscription> };

/** AUSD transferWithAuthorization: send to someone who already has Polaris. */
export type TransferRequest = { to: Person; authorization: Signed<Authorization> };

/** PolarisLoanEngine.repayWithSig: pay a plan early. */
export type PayEarlyRequest = { planId: string; loanId: bigint; borrower: Address; repay: Signed<RepayIntent> };

/**
 * PolarisCheckout.reauthorize: the borrower's ERC-2612 permit to the loan
 * engine, signed again after a collection failed for a lost approval. Its
 * Reauthorized event starts the collections workflow's instant retry.
 */
export type ReauthorizeRequest = { buyer: Address; permit: Signed<Permit> };

/**
 * CollateralVault.lockWithPermit: add to Boost. The borrower's ERC-2612
 * permit to the vault for exactly the amount (lib/boost.ts).
 */
export type LockCollateralRequest = { permit: Signed<Permit> };

/**
 * CollateralVault.withdrawWithSig: take out of Boost. The borrower's EIP-712
 * Withdraw under the vault's domain; the vault pays the borrower only.
 */
export type WithdrawCollateralRequest = { withdraw: Signed<Withdraw> };

/**
 * PolarisSplit.createSplit: the organiser's CreateSplit. The split's words
 * never go to the relayer, only their hash (inside `creation`).
 */
export type CreateSplitRequest = { creation: Signed<CreateSplit> };

/** PolarisSplit.payShare: a friend's ERC-3009 authorisation for exactly their share. */
export type PayShareRequest = { splitId: Hex; index: number; payer: Address; authorization: Signed<Authorization> };

/** PolarisSplit.closeSplit: the organiser's CloseSplit. */
export type CloseSplitRequest = { close: Signed<CloseSplit> };

export interface Relayer {
  createSplit(request: CreateSplitRequest): Promise<RelayReceipt>;
  payShare(request: PayShareRequest): Promise<RelayReceipt>;
  closeSplit(request: CloseSplitRequest): Promise<RelayReceipt>;
  payNow(request: PayNowRequest): Promise<RelayReceipt>;
  openPlan(request: OpenPlanRequest): Promise<RelayReceipt>;
  subscribe(request: SubscribeRequest): Promise<RelayReceipt>;
  send(request: SendRequest): Promise<RelayReceipt>;
  claim(request: ClaimRequest): Promise<RelayReceipt>;
  cancelSend(request: CancelSendRequest): Promise<RelayReceipt>;
  cancelSubscription(request: CancelSubscriptionRequest): Promise<RelayReceipt>;
  transfer(request: TransferRequest): Promise<RelayReceipt>;
  payEarly(request: PayEarlyRequest): Promise<RelayReceipt>;
  reauthorize(request: ReauthorizeRequest): Promise<RelayReceipt>;
  lockCollateral(request: LockCollateralRequest): Promise<RelayReceipt>;
  withdrawCollateral(request: WithdrawCollateralRequest): Promise<RelayReceipt>;
}

export type RelayErrorReason = "insufficient-funds" | "over-limit" | "invalid-signature" | "already-settled" | "expired" | "unavailable";

export class RelayError extends Error {
  readonly reason: RelayErrorReason;
  readonly code: string | undefined;
  constructor(reason: RelayErrorReason, message: string, code?: string) {
    super(message);
    this.name = "RelayError";
    this.reason = reason;
    this.code = code;
  }
}

/* ── The real relayer: POST /api/relay ──────────────────────────────────── */

const REASONS: Record<string, RelayErrorReason> = {
  insufficient_funds: "insufficient-funds",
  over_limit: "over-limit",
  credit_unavailable: "over-limit",
  merchant_not_eligible: "over-limit",
  invalid_signature: "invalid-signature",
  stale_signature: "invalid-signature",
  signature_expired: "expired",
  session_expired: "expired",
  link_expired: "expired",
  already_paid: "already-settled",
  already_used: "already-settled",
  link_used: "already-settled",
  payment_in_progress: "already-settled",
  nothing_owed: "already-settled",
  already_authorised: "already-settled",
  split_closed: "already-settled",
  split_expired: "expired",
  split_exists: "already-settled",
  split_unavailable: "unavailable",
  insufficient_balance: "insufficient-funds",
  wrong_amount: "invalid-signature",
  collateral_unavailable: "unavailable",
  withdraw_unavailable: "unavailable",
  insufficient_collateral: "insufficient-funds",
  collateral_in_use: "over-limit",
  transaction_reverted: "unavailable",
};

type RelayResponse = {
  txHash: Hex;
  status: "submitted" | "confirmed";
  explorerUrl: string | null;
  submittedAt: number;
  confirmedAt: number | null;
  paymentId?: string;
  planId?: string;
  subscriptionId?: string;
  splitId?: string;
  shareIndex?: string;
};

async function relay(body: Record<string, unknown>): Promise<RelayReceipt> {
  let out: RelayResponse;
  try {
    out = await api<RelayResponse>("/api/relay", { method: "POST", body });
  } catch (error) {
    if (error instanceof ApiError) throw new RelayError(REASONS[error.code] ?? "unavailable", error.message, error.code);
    throw error;
  }
  notifyDataChanged();
  return {
    txHash: out.txHash,
    submittedAt: out.submittedAt,
    finalizedAt: out.confirmedAt ?? Date.now(),
    // The server's own explorer link; null (a local chain) means there is none to show.
    explorerUrl: out.explorerUrl === undefined ? receiptUrl(out.txHash) : out.explorerUrl,
    paymentId: out.paymentId,
    planId: out.planId,
    subscriptionId: out.subscriptionId,
    splitId: out.splitId,
    shareIndex: out.shareIndex,
  };
}

const str = (v: bigint | number) => v.toString();

function permitBody(permit: Signed<Permit>) {
  return { value: str(permit.message.value), deadline: str(permit.message.deadline), signature: permit.signature };
}

/** Polaris for Business's relayer, the only one. */
export const relayer: Relayer = {
  createSplit: ({ creation }) =>
    relay({
      type: "createSplit",
      creation: {
        organiser: creation.message.organiser,
        salt: creation.message.salt,
        amounts: creation.message.amounts.map(str),
        memoHash: creation.message.memoHash,
        expiresAt: str(creation.message.expiresAt),
        deadline: str(creation.message.deadline),
      },
      signature: creation.signature,
    }),
  payShare: ({ splitId, index, payer, authorization }) =>
    relay({
      type: "payShare",
      splitId,
      index: String(index),
      payer,
      amount: str(authorization.message.value),
      validAfter: str(authorization.message.validAfter),
      validBefore: str(authorization.message.validBefore),
      signature: authorization.signature,
    }),
  closeSplit: ({ close }) => relay({ type: "closeSplit", splitId: close.message.splitId, deadline: str(close.message.deadline), signature: close.signature }),
  payNow: ({ link, payer, authorization }) =>
    relay({
      type: "pay",
      sessionId: link.id,
      buyer: payer,
      amount: str(authorization.message.value),
      validAfter: str(authorization.message.validAfter),
      validBefore: str(authorization.message.validBefore),
      signature: authorization.signature,
    }),
  openPlan: ({ link, intent, permit }) =>
    relay({
      type: "openPlan",
      sessionId: link.id,
      intent: {
        buyer: intent.message.buyer,
        principal: str(intent.message.principal),
        installments: str(intent.message.installments),
        interval: str(intent.message.interval),
        nonce: str(intent.message.nonce),
        deadline: str(intent.message.deadline),
      },
      signature: intent.signature,
      permit: permitBody(permit),
    }),
  subscribe: ({ link, intent, permit }) =>
    relay({
      type: "subscribe",
      sessionId: link.id,
      intent: {
        buyer: intent.message.buyer,
        planId: str(intent.message.planId),
        pricePerPeriod: str(intent.message.pricePerPeriod),
        periodSeconds: str(intent.message.periodSeconds),
        nonce: str(intent.message.nonce),
        deadline: str(intent.message.deadline),
      },
      signature: intent.signature,
      permit: permitBody(permit),
    }),
  send: ({ sender, linkKey, amount, expiresAt, authorization, open }) =>
    relay({
      type: "send",
      sender,
      linkKey,
      amount: str(amount),
      expiresAt: str(expiresAt),
      validAfter: str(authorization.message.validAfter),
      validBefore: str(authorization.message.validBefore),
      signature: authorization.signature,
      linkSignature: open.signature,
    }),
  claim: ({ linkKey, claim }) => relay({ type: "claim", linkKey, to: claim.message.to, deadline: str(claim.message.deadline), signature: claim.signature }),
  cancelSend: ({ cancel }) => relay({ type: "cancelSend", linkKey: cancel.message.linkKey, deadline: str(cancel.message.deadline), signature: cancel.signature }),
  cancelSubscription: ({ cancel }) =>
    relay({ type: "cancelSubscription", subId: str(cancel.message.subId), deadline: str(cancel.message.deadline), signature: cancel.signature }),
  transfer: ({ authorization }) =>
    relay({
      type: "transfer",
      from: authorization.message.from,
      to: authorization.message.to,
      value: str(authorization.message.value),
      validAfter: str(authorization.message.validAfter),
      validBefore: str(authorization.message.validBefore),
      nonce: authorization.message.nonce,
      signature: authorization.signature,
    }),
  payEarly: ({ repay }) =>
    relay({
      type: "repay",
      loanId: str(repay.message.loanId),
      amount: str(repay.message.amount),
      expectedRepaid: str(repay.message.expectedRepaid),
      deadline: str(repay.message.deadline),
      signature: repay.signature,
    }),
  reauthorize: ({ buyer, permit }) => relay({ type: "reauthorize", buyer, permit: permitBody(permit) }),
  lockCollateral: ({ permit }) => relay(lockCollateralBody(permit)),
  withdrawCollateral: ({ withdraw }) => relay(withdrawCollateralBody(withdraw)),
};

import "server-only";

import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi, type Hex } from "viem";

import {
  collectionsReceiverAbi,
  iausdAbi,
  merchantRegistryAbi,
  polarisCheckoutAbi,
  polarisLoanEngineAbi,
  polarisPaymentsAbi,
  polarisSendAbi,
  polarisSplitAbi,
} from "./abis";
import { mockAUSDAbi } from "@polarispay/contracts/abi";

import { GUARD_PAUSED_MESSAGE } from "@/lib/data/guard";

/**
 * Turn a revert into something a person can act on.
 *
 * The relayer simulates every call before it spends gas; when the simulation
 * reverts, the contract's custom error is decoded against every Polaris ABI
 * (and both AUSD and MockAUSD's) and mapped to a stable `code` and a message
 * written for the buyer, in the words of docs/plan.md ("Words the buyer never
 * sees"): no wallet, no gas, no token names.
 */

export type RevertInfo = { name: string; args: readonly unknown[] };

export type BuyerError = { status: number; code: string; message: string; revert: RevertInfo | null };

const ABIS: Abi[] = [
  polarisCheckoutAbi,
  polarisLoanEngineAbi,
  polarisPaymentsAbi,
  polarisSendAbi,
  polarisSplitAbi,
  merchantRegistryAbi,
  collectionsReceiverAbi,
  iausdAbi,
  mockAUSDAbi,
] as unknown as Abi[];

/** Decode revert data against every ABI we know. */
export function decodeRevert(data: Hex | undefined | null): RevertInfo | null {
  if (!data || data === "0x" || data.length < 10) return null;
  for (const abi of ABIS) {
    try {
      const out = decodeErrorResult({ abi, data });
      return { name: out.errorName, args: (out.args ?? []) as readonly unknown[] };
    } catch {
      // try the next ABI
    }
  }
  return null;
}

/** Find revert data anywhere in a viem error chain. */
export function revertDataOf(error: unknown): Hex | null {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return reverted.raw;
    let data: Hex | null = null;
    error.walk((e) => {
      const d = (e as { data?: unknown }).data;
      if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
        data = d as Hex;
        return true;
      }
      if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") {
        data = (d as { data: Hex }).data;
        return true;
      }
      return false;
    });
    return data;
  }
  return null;
}

const MESSAGES: Record<string, { status: number; code: string; message: string }> = {
  ExceedsCreditLimit: { status: 402, code: "over_limit", message: "This is more than your Polaris limit right now. Pay now instead, or pay less." },
  InsufficientAllowance: { status: 400, code: "allowance_too_low", message: "Confirm again: the payment schedule needs a fresh confirmation." },
  ERC20InsufficientAllowance: { status: 400, code: "allowance_too_low", message: "Confirm again: the payment schedule needs a fresh confirmation." },
  InsufficientBalance: { status: 402, code: "insufficient_funds", message: "Not enough dollars in your account for this." },
  ERC20InsufficientBalance: { status: 402, code: "insufficient_funds", message: "Not enough dollars in your account for this." },
  InvalidSignature: { status: 400, code: "invalid_signature", message: "That confirmation didn't go through. Try again." },
  InvalidAuthorizationSignature: { status: 400, code: "invalid_signature", message: "That confirmation didn't go through. Try again." },
  InvalidAuthorization: { status: 400, code: "invalid_signature", message: "That confirmation didn't go through. Try again." },
  ERC2612InvalidSigner: { status: 400, code: "invalid_signature", message: "That confirmation didn't go through. Try again." },
  Erc2612InvalidSignature: { status: 400, code: "invalid_signature", message: "That confirmation didn't go through. Try again." },
  InvalidOpenSignature: { status: 400, code: "invalid_signature", message: "That link couldn't be created. Try again." },
  InvalidClaimSignature: { status: 400, code: "invalid_signature", message: "That link doesn't match. Open it again from the message you got." },
  ECDSAInvalidSignature: { status: 400, code: "invalid_signature", message: "That confirmation didn't go through. Try again." },
  SignatureExpired: { status: 400, code: "signature_expired", message: "That confirmation expired. Try again." },
  AuthorizationExpired: { status: 400, code: "signature_expired", message: "That confirmation expired. Try again." },
  ExpiredAuthorization: { status: 400, code: "signature_expired", message: "That confirmation expired. Try again." },
  ERC2612ExpiredSignature: { status: 400, code: "signature_expired", message: "That confirmation expired. Try again." },
  Erc2612ExpiredSignature: { status: 400, code: "signature_expired", message: "That confirmation expired. Try again." },
  AuthorizationNotYetValid: { status: 400, code: "signature_not_yet_valid", message: "That confirmation isn't valid yet. Try again in a moment." },
  SignatureWindowTooLong: { status: 400, code: "signature_window_too_long", message: "That confirmation is valid for too long. Try again." },
  InvalidAccountNonce: { status: 409, code: "stale_signature", message: "Something changed since you confirmed. Try again." },
  StaleIntent: { status: 409, code: "stale_signature", message: "Something changed since you confirmed. Try again." },
  AuthorizationAlreadyUsed: { status: 409, code: "already_used", message: "That confirmation was already used." },
  UsedOrCanceledAuthorization: { status: 409, code: "already_used", message: "That confirmation was already used." },
  OrderAlreadySettled: { status: 409, code: "already_paid", message: "This has already been paid." },
  DuplicatePayment: { status: 409, code: "already_paid", message: "This has already been paid." },
  WrongAmount: { status: 400, code: "wrong_amount", message: "The price changed. Open the checkout again." },
  PlanMismatch: { status: 400, code: "plan_mismatch", message: "The subscription's terms changed. Open the checkout again." },
  PlanNotActive: { status: 409, code: "plan_unavailable", message: "This subscription isn't available any more." },
  AlreadySubscribed: { status: 409, code: "already_subscribed", message: "You're already subscribed." },
  MerchantNotEligible: { status: 409, code: "merchant_not_eligible", message: "This business can't offer Pay in 4 for this amount yet. Pay now instead." },
  // The CRE guardian paused new Pay in 4 plans (PolarisCheckout.openPlan); Pay now, Send and Subscribe carry on.
  CreditPausedByGuardian: { status: 503, code: "credit_paused", message: GUARD_PAUSED_MESSAGE },
  // PolarisCheckout.reauthorize: signing again for instalments already owed.
  NothingOwed: { status: 409, code: "nothing_owed", message: "You don't owe anything on Pay in 4 right now." },
  PermitBelowDebt: { status: 409, code: "stale_signature", message: "What you owe changed since you confirmed. Try again." },
  InsufficientLiquidity: { status: 503, code: "credit_unavailable", message: "Pay in 4 isn't available right now. Pay now instead." },
  InvalidInstallments: { status: 400, code: "invalid_plan", message: "That payment schedule isn't available." },
  InvalidInterval: { status: 400, code: "invalid_plan", message: "That payment schedule isn't available." },
  EnforcedPause: { status: 503, code: "paused", message: "Checkout is paused for maintenance. Nothing was charged; try again soon." },
  TransferPaused: { status: 503, code: "paused", message: "Payments are paused for maintenance. Nothing was charged; try again soon." },
  SignatureVerificationPaused: { status: 503, code: "paused", message: "Payments are paused for maintenance. Nothing was charged; try again soon." },
  AccountIsFrozen: { status: 403, code: "account_frozen", message: "This account can't send or receive dollars right now." },
  LinkKeyUsed: { status: 409, code: "link_used", message: "This link has already been used." },
  LinkNotFound: { status: 404, code: "link_not_found", message: "This link has already been claimed or cancelled." },
  LinkExpired: { status: 410, code: "link_expired", message: "This link has expired. The money went back to the sender." },
  InvalidExpiry: { status: 400, code: "invalid_expiry", message: "That link's expiry isn't allowed." },
  InvalidAmount: { status: 400, code: "invalid_amount", message: "That amount isn't allowed." },
  NotSender: { status: 403, code: "not_sender", message: "Only the person who sent this link can cancel it." },
  NotExpired: { status: 409, code: "not_expired", message: "This link hasn't expired yet." },
  NotDue: { status: 409, code: "not_due", message: "Nothing is due yet." },
  LoanNotActive: { status: 409, code: "plan_closed", message: "This plan is already paid off." },
  InvalidLoan: { status: 404, code: "plan_not_found", message: "We couldn't find that plan." },
  NotBorrower: { status: 403, code: "not_borrower", message: "Only the account that owes this plan can pay it." },
  NotSubscriber: { status: 403, code: "not_subscriber", message: "Only the subscriber can cancel this subscription." },
  SubscriptionNotActive: { status: 409, code: "subscription_closed", message: "This subscription has already ended." },
  AlreadyRegistered: { status: 409, code: "already_registered", message: "This business is already registered." },
  NotRegistered: { status: 409, code: "not_registered", message: "This business isn't registered yet." },
  NotOperator: { status: 503, code: "relayer_not_authorised", message: "Polaris isn't set up to do this yet. Nothing was charged." },
  OwnableUnauthorizedAccount: { status: 503, code: "relayer_not_authorised", message: "Polaris isn't set up to do this yet. Nothing was charged." },
  EmptyOrderId: { status: 400, code: "invalid_order", message: "This checkout is missing its order reference." },
  ZeroAmount: { status: 400, code: "invalid_amount", message: "That amount isn't allowed." },
  ZeroAddress: { status: 400, code: "invalid_request", message: "That request is missing an account." },
  // PolarisSplit: split-the-bill links.
  SplitExists: { status: 409, code: "split_exists", message: "This split is already open." },
  SplitNotFound: { status: 404, code: "split_not_found", message: "We couldn't find that split." },
  SplitIsClosed: { status: 409, code: "split_closed", message: "This split was closed, so it can't be paid any more. Nothing was charged." },
  SplitExpired: { status: 410, code: "split_expired", message: "This split has expired. Nothing was charged." },
  ShareAlreadyPaid: { status: 409, code: "already_paid", message: "This share has already been paid." },
  ShareOutOfRange: { status: 400, code: "invalid_share", message: "That share isn't part of this split." },
  NoShares: { status: 400, code: "invalid_split", message: "A split needs at least one share." },
  TooManyShares: { status: 400, code: "invalid_split", message: "A split can have at most 50 shares." },
};

const FALLBACK = { status: 422, code: "transaction_would_fail", message: "This can't go through right now. Nothing was charged." };

export function buyerErrorFor(revert: RevertInfo | null): BuyerError {
  const known = revert ? MESSAGES[revert.name] : undefined;
  return { ...(known ?? FALLBACK), revert };
}

/** From a thrown viem error to a buyer-facing error. */
export function buyerErrorFromThrown(error: unknown): BuyerError {
  return buyerErrorFor(decodeRevert(revertDataOf(error)));
}

/** A revert reason a CRE collections report recorded (`TaskSkipped.reason`). */
export function failureReasonOf(reason: Hex): "insufficient_funds" | "allowance_lost" | "stale" | "other" {
  const revert = decodeRevert(reason);
  switch (revert?.name) {
    case "InsufficientBalance":
    case "ERC20InsufficientBalance":
      return "insufficient_funds";
    case "InsufficientAllowance":
    case "ERC20InsufficientAllowance":
      return "allowance_lost";
    case "NotDue":
    case "LoanNotActive":
    case "InvalidLoan":
    case "SubscriptionNotActive":
      return "stale";
    case "Error": {
      // A token that reverts with a message (OpenZeppelin 4's "ERC20: insufficient allowance"), read as the
      // indexer (packages/indexer src/lib/revert.ts) and the collections workflow (outcomes.ts) read it.
      const message = typeof revert.args[0] === "string" ? revert.args[0].toLowerCase() : "";
      if (message.includes("allowance")) return "allowance_lost";
      if (message.includes("balance")) return "insufficient_funds";
      return "other";
    }
    default:
      return "other";
  }
}

import type { Address, Hex, TypedData, TypedDataDefinition } from "viem";
import type { Eip712Domain } from "./domain.ts";
import {
  cancelSubscriptionTypes,
  cancelTypes,
  claimTypes,
  closeSplitTypes,
  createSplitTypes,
  openTypes,
  permitTypes,
  planIntentTypes,
  receiveWithAuthorizationTypes,
  repayIntentTypes,
  subscribeIntentTypes,
  transferWithAuthorizationTypes,
  withdrawTypes,
} from "./types.ts";

/**
 * Typed-data builders. Each takes the domain (read from the verifying
 * contract, see `readDomain`) and the message, and returns exactly what
 * `account.signTypedData(...)` takes. They do no I/O, so a checkout can build
 * everything before the Face ID prompt and sign right after it.
 */

/**
 * A typed-data payload: exactly viem's `TypedDataDefinition` (so it type-checks
 * the message against the struct), with the domain required and the message
 * keeping its named type.
 */
export type Typed<T extends TypedData, P extends keyof T & string, M> = TypedDataDefinition<T, P> & {
  domain: Eip712Domain;
  message: M;
};

export type PlanIntent = {
  buyer: Address;
  merchant: Address;
  principal: bigint;
  installments: number;
  interval: bigint;
  /** The merchant's order reference, as the text it is (a Solidity `string`). */
  orderId: string;
  /** `PolarisCheckout.nonces(buyer)`: one sequence shared with SubscribeIntent. */
  nonce: bigint;
  deadline: bigint;
};

export type SubscribeIntent = {
  buyer: Address;
  merchant: Address;
  planId: bigint;
  pricePerPeriod: bigint;
  periodSeconds: bigint;
  orderId: string;
  /** PolarisCheckout.nonces(buyer), shared with PlanIntent. */
  nonce: bigint;
  deadline: bigint;
};

export type Authorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

export type Permit = { owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint };

export type Open = { sender: Address; amount: bigint; expiresAt: bigint };

export type Claim = { to: Address; deadline: bigint };

export type Cancel = { linkKey: Address; deadline: bigint };

export type CancelSubscription = { subId: bigint; deadline: bigint };

/** PolarisSplit.Creation, as the organiser signs it. */
export type CreateSplit = { organiser: Address; salt: Hex; amounts: bigint[]; memoHash: Hex; expiresAt: bigint; deadline: bigint };

export type CloseSplit = { splitId: Hex; deadline: bigint };

export type RepayIntent = { loanId: bigint; amount: bigint; expectedRepaid: bigint; nonce: bigint; deadline: bigint };

/** CollateralVault.withdrawWithSig: take dollars out of Boost; the vault pays `borrower` only. */
export type Withdraw = { borrower: Address; amount: bigint; nonce: bigint; deadline: bigint };

/** PolarisCheckout.openPlan: signed by the buyer together with a Permit. */
export function buildPlanIntent(
  domain: Eip712Domain,
  message: PlanIntent,
): Typed<typeof planIntentTypes, "PlanIntent", PlanIntent> {
  if (!Number.isInteger(message.installments) || message.installments < 1 || message.installments > 0xffffffff) {
    throw new RangeError("installments must fit a uint32");
  }
  if (message.interval < 0n || message.interval > 0xffffffffffffffffn) {
    throw new RangeError("interval must fit a uint64");
  }
  return { domain, types: planIntentTypes, primaryType: "PlanIntent", message };
}

/** PolarisCheckout.subscribe: signed by the buyer together with a Permit. */
export function buildSubscribeIntent(
  domain: Eip712Domain,
  message: SubscribeIntent,
): Typed<typeof subscribeIntentTypes, "SubscribeIntent", SubscribeIntent> {
  if (message.periodSeconds < 0n || message.periodSeconds > 0xffffffffffffffffn) {
    throw new RangeError("periodSeconds must fit a uint64");
  }
  return { domain, types: subscribeIntentTypes, primaryType: "SubscribeIntent", message };
}

/** ERC-3009 on the dollar token. Pay now and send-by-link use this one. */
export function buildReceiveWithAuthorization(
  domain: Eip712Domain,
  message: Authorization,
): Typed<typeof receiveWithAuthorizationTypes, "ReceiveWithAuthorization", Authorization> {
  return { domain, types: receiveWithAuthorizationTypes, primaryType: "ReceiveWithAuthorization", message };
}

/** ERC-3009 on the dollar token. Sending to an existing account uses this one. */
export function buildTransferWithAuthorization(
  domain: Eip712Domain,
  message: Authorization,
): Typed<typeof transferWithAuthorizationTypes, "TransferWithAuthorization", Authorization> {
  return { domain, types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization", message };
}

/** ERC-2612 on the dollar token. `nonce` comes from the token's `nonces(owner)`. */
export function buildPermit(
  domain: Eip712Domain,
  message: Permit,
): Typed<typeof permitTypes, "Permit", Permit> {
  return { domain, types: permitTypes, primaryType: "Permit", message };
}

/** PolarisSend.send: the link's throwaway key opens the link for this sender and amount. */
export function buildOpen(domain: Eip712Domain, message: Open): Typed<typeof openTypes, "Open", Open> {
  return { domain, types: openTypes, primaryType: "Open", message };
}

/** PolarisSend.claim: signed by the link's throwaway key, never by an account. */
export function buildClaim(domain: Eip712Domain, message: Claim): Typed<typeof claimTypes, "Claim", Claim> {
  return { domain, types: claimTypes, primaryType: "Claim", message };
}

/** PolarisSend.cancel: signed by the sender. */
export function buildCancel(
  domain: Eip712Domain,
  message: Cancel,
): Typed<typeof cancelTypes, "Cancel", Cancel> {
  return { domain, types: cancelTypes, primaryType: "Cancel", message };
}

/** PolarisSplit.createSplit: signed by the organiser. At most 50 shares, each more than zero, each fitting a uint128. */
export function buildCreateSplit(
  domain: Eip712Domain,
  message: CreateSplit,
): Typed<typeof createSplitTypes, "CreateSplit", CreateSplit> {
  if (message.amounts.length < 1 || message.amounts.length > 50) throw new RangeError("a split has 1 to 50 shares");
  if (message.amounts.some((a) => a <= 0n || a >= 1n << 128n)) throw new RangeError("every share must be more than zero and fit a uint128");
  if (message.expiresAt < 0n || message.expiresAt > 0xffffffffffffffffn) throw new RangeError("expiresAt must fit a uint64");
  return { domain, types: createSplitTypes, primaryType: "CreateSplit", message };
}

/** PolarisSplit.closeSplit: signed by the organiser. */
export function buildCloseSplit(domain: Eip712Domain, message: CloseSplit): Typed<typeof closeSplitTypes, "CloseSplit", CloseSplit> {
  return { domain, types: closeSplitTypes, primaryType: "CloseSplit", message };
}

/** PolarisLoanEngine.repayWithSig: signed by the borrower. */
export function buildRepayIntent(
  domain: Eip712Domain,
  message: RepayIntent,
): Typed<typeof repayIntentTypes, "RepayIntent", RepayIntent> {
  return { domain, types: repayIntentTypes, primaryType: "RepayIntent", message };
}

/** CollateralVault.withdrawWithSig: signed by the borrower, under the vault's own domain. */
export function buildWithdraw(domain: Eip712Domain, message: Withdraw): Typed<typeof withdrawTypes, "Withdraw", Withdraw> {
  if (message.amount <= 0n) throw new RangeError("amount must be more than zero");
  return { domain, types: withdrawTypes, primaryType: "Withdraw", message };
}

/** PolarisPayments.cancelWithSignature: signed by the subscriber. */
export function buildCancelSubscription(
  domain: Eip712Domain,
  message: CancelSubscription,
): Typed<typeof cancelSubscriptionTypes, "CancelSubscription", CancelSubscription> {
  return { domain, types: cancelSubscriptionTypes, primaryType: "CancelSubscription", message };
}

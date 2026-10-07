/**
 * Rows as the client returns them: BigInt columns as `bigint` (AUSD base
 * units, 6 decimals), timestamps as unix seconds, addresses and hashes as
 * lowercase hex. Each type is exactly its fragment in documents.ts.
 */

export type Hex = `0x${string}`;

export type PaymentMode = "PAY_NOW" | "PAY_IN_4" | "SUBSCRIPTION";
export type PlanStatus = "ACTIVE" | "REPAID" | "LIQUIDATED";
export type SubscriptionStatus = "ACTIVE" | "CANCELLED" | "LAPSED";
export type InstallmentStatus = "PENDING" | "PAID" | "WRITTEN_OFF";
export type SendStatus = "OPEN" | "CLAIMED" | "CANCELLED" | "REFUNDED";
export type OrderStatus = "QUOTED" | "PAID";
/** What a skipped collection asks of the buyer. */
/** What a skipped task asks of the buyer: the CRE collections workflow's words (polarispay-sdk's InstallmentFailureReason, plus `stale`). */
export type ReasonAction = "allowance_lost" | "insufficient_funds" | "stale" | "other";
/** Why a collection failed, in polarispay-sdk's words (its InstallmentFailureReason). */
export type InstallmentFailureReason = "insufficient_funds" | "allowance_lost" | "other";
/** Who ended a subscription, in polarispay-sdk's words. */
export type CanceledBy = "subscriber" | "merchant" | "lapsed";
export type PaidBy = "BUYER" | "CRE" | "KEEPER";

export const WEBHOOK_KINDS = [
  "payment.succeeded",
  "plan.opened",
  "installment.collected",
  "installment.failed",
  "plan.completed",
  "plan.liquidated",
  "subscription.charged",
  "subscription.canceled",
  "payout.paid",
] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

export type Merchant = {
  id: string;
  registered: boolean;
  name: string | null;
  payoutAddress: string | null;
  active: boolean;
  maxOrderValue: bigint | null;
  registeredAt: number | null;
  registeredBy: string | null;
  paymentCount: number;
  grossVolume: bigint;
  feeVolume: bigint;
  netVolume: bigint;
  payNowCount: number;
  payNowVolume: bigint;
  planCount: number;
  planVolume: bigint;
  subscriptionChargeCount: number;
  subscriptionVolume: bigint;
  customerCount: number;
  activePlanCount: number;
  outstanding: bigint;
  dunningPlanCount: number;
  atRiskOutstanding: bigint;
  repaidPlanCount: number;
  liquidatedPlanCount: number;
  activeSubscriptionCount: number;
  mrr: bigint;
  balance: bigint;
  payoutCount: number;
  payoutVolume: bigint;
  firstSeenAt: number;
  lastPaymentAt: number | null;
  updatedAt: number;
};

export type Payment = {
  id: string;
  merchant_id: string;
  buyer_id: string;
  mode: PaymentMode;
  amount: bigint;
  fee: bigint;
  net: bigint;
  orderId: string | null;
  orderKey: string | null;
  quotedAmount: bigint | null;
  plan_id: string | null;
  subscription_id: string | null;
  period: number | null;
  viaCheckout: boolean;
  relayer: string;
  timestamp: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
};

export type Installment = {
  id: string;
  index: number;
  dueAt: number;
  amount: bigint;
  paid: bigint;
  status: InstallmentStatus;
  paidAt: number | null;
  onTime: boolean | null;
  paidBy: PaidBy | null;
  paidTxHash: string | null;
  failedAttempts: number;
  lastFailureReason: string | null;
  lastFailureAt: number | null;
};

export type Plan = {
  id: string;
  loanId: bigint;
  merchant_id: string;
  buyer_id: string;
  orderId: string | null;
  orderKey: string | null;
  principal: bigint;
  totalOwed: bigint;
  interest: bigint;
  installmentCount: number;
  installmentAmount: bigint;
  interval: number;
  startedAt: number;
  firstDueAt: number | null;
  totalRepaid: bigint;
  outstanding: bigint;
  installmentsPaid: number;
  nextDueAt: number | null;
  liquidatableAt: number | null;
  nextAttemptAt: number | null;
  status: PlanStatus;
  dunning: boolean;
  failedAttempts: number;
  lastFailureReason: string | null;
  lastFailureAction: ReasonAction | null;
  lastFailureAt: number | null;
  recovered: bigint;
  loss: bigint;
  closedAt: number | null;
  openedTxHash: string;
  relayer: string;
  updatedAt: number;
  installments: Installment[];
};

export type Repayment = {
  id: string;
  amount: bigint;
  installmentIndex: number;
  installmentsCompleted: number;
  onTime: boolean;
  source: PaidBy;
  bonusWithheld: boolean;
  relayer: string;
  timestamp: number;
  txHash: string;
};

export type Subscription = {
  id: string;
  subId: bigint;
  plan_id: string;
  merchant_id: string;
  buyer_id: string;
  orderId: string | null;
  orderKey: string | null;
  pricePerPeriod: bigint;
  periodSeconds: number;
  startedAt: number;
  nextChargeAt: number | null;
  nextAttemptAt: number | null;
  periodsCharged: number;
  missedCharges: number;
  status: SubscriptionStatus;
  totalCharged: bigint;
  failedAttempts: number;
  lastFailureReason: string | null;
  lastFailureAt: number | null;
  cancelledBy: string | null;
  endedAt: number | null;
  updatedAt: number;
};

export type Payout = {
  id: string;
  merchant_id: string;
  amount: bigint;
  destination: string;
  toPayoutAddress: boolean;
  relayer: string;
  timestamp: number;
  blockNumber: number;
  txHash: string;
};

export type Customer = {
  id: string;
  buyer_id: string;
  firstPaidAt: number;
  lastPaidAt: number;
  paymentCount: number;
  volume: bigint;
};

export type MerchantDay = {
  id: string;
  day: number;
  date: string;
  paymentCount: number;
  grossVolume: bigint;
  feeVolume: bigint;
  netVolume: bigint;
  payNowCount: number;
  payNowVolume: bigint;
  planCount: number;
  planVolume: bigint;
  subscriptionChargeCount: number;
  subscriptionVolume: bigint;
  installmentsCompleted: number;
  repaidVolume: bigint;
  failedCollections: number;
  newCustomers: number;
  payoutCount: number;
  payoutVolume: bigint;
  /** Payment sizes: first, largest, smallest, last. Null on a day with no payment. */
  open: bigint | null;
  high: bigint | null;
  low: bigint | null;
  close: bigint | null;
  balanceOpen: bigint;
  balanceHigh: bigint;
  balanceLow: bigint;
  balanceClose: bigint;
};

export type Order = {
  id: string;
  merchant_id: string;
  orderId: string | null;
  status: OrderStatus;
  kind: PaymentMode | null;
  quotedAmount: bigint | null;
  quotedAt: number | null;
  amount: bigint | null;
  quoteMatched: boolean | null;
  buyer: string | null;
  payment_id: string | null;
  plan_id: string | null;
  subscription_id: string | null;
  settledAt: number | null;
  settledBlock: number | null;
  txHash: string | null;
};

export type Activity = {
  id: string;
  cursor: bigint;
  kind: WebhookKind;
  merchant_id: string;
  buyer: string | null;
  orderId: string | null;
  orderKey: string | null;
  mode: PaymentMode | null;
  amount: bigint;
  fee: bigint | null;
  refId: string;
  /** installment.*: 0-based. */
  installmentIndex: number | null;
  installmentCount: number | null;
  principal: bigint | null;
  interval: number | null;
  firstDueAt: number | null;
  remaining: bigint | null;
  recovered: bigint | null;
  attempt: number | null;
  /** installment.failed: null when the next step is liquidation. */
  nextAttemptAt: number | null;
  failureReason: InstallmentFailureReason | null;
  subscriptionPlanId: string | null;
  period: number | null;
  nextChargeAt: number | null;
  canceledBy: CanceledBy | null;
  reason: string | null;
  reasonAction: ReasonAction | null;
  destination: string | null;
  timestamp: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
};

export type Buyer = {
  id: string;
  score: number;
  hasRecord: boolean;
  underwritten: boolean;
  declined: boolean;
  baseLimit: bigint;
  collateral: bigint;
  creditLimit: bigint;
  activeDebt: bigint;
  available: bigint;
  linkedWallet: string | null;
  underwrittenAt: number | null;
  lastUnderwritingRefusal: string | null;
  onTimeInstallments: number;
  lateInstallments: number;
  liquidations: number;
  planCount: number;
  activePlanCount: number;
  paymentCount: number;
  spent: bigint;
  activeSubscriptionCount: number;
  sentCount: number;
  sentVolume: bigint;
  claimedCount: number;
  claimedVolume: bigint;
  firstSeenAt: number;
  updatedAt: number;
};

export type ScoreEvent = {
  id: string;
  oldScore: number;
  newScore: number;
  delta: number;
  reason: string;
  timestamp: number;
  txHash: string;
};

export type BuyerDay = {
  id: string;
  day: number;
  date: string;
  scoreOpen: number;
  scoreHigh: number;
  scoreLow: number;
  scoreClose: number;
  spent: bigint;
  repaid: bigint;
};

export type Send = {
  id: string;
  sender: string;
  amount: bigint;
  expiresAt: number;
  status: SendStatus;
  recipient: string | null;
  sentAt: number;
  closedAt: number | null;
  sentTxHash: string;
  closedTxHash: string | null;
  relayer: string;
};

export type Protocol = {
  id: string;
  feeBps: number;
  requireUnderwriting: boolean;
  collateralMultiplierBps: number;
  collateralCountsTowardLimits: boolean;
  checkoutPaused: boolean;
  merchantCount: number;
  registeredMerchantCount: number;
  buyerCount: number;
  paymentCount: number;
  grossVolume: bigint;
  feeVolume: bigint;
  payNowCount: number;
  payNowVolume: bigint;
  planCount: number;
  activePlanCount: number;
  principalOriginated: bigint;
  outstanding: bigint;
  repaidVolume: bigint;
  installmentsCompleted: number;
  creCollections: number;
  liquidationCount: number;
  lossVolume: bigint;
  subscriptionCount: number;
  activeSubscriptionCount: number;
  subscriptionVolume: bigint;
  sendCount: number;
  sendVolume: bigint;
  claimCount: number;
  claimVolume: bigint;
  payoutCount: number;
  payoutVolume: bigint;
  collectionsRuns: number;
  lastCollectionsRunAt: number | null;
  lastCollectionsRunBlock: number | null;
  creReports: number;
  creReportsFailed: number;
  underwritings: number;
  updatedAt: number;
};

export type ProtocolDay = {
  id: string;
  day: number;
  date: string;
  paymentCount: number;
  grossVolume: bigint;
  feeVolume: bigint;
  planCount: number;
  principalOriginated: bigint;
  installmentsCompleted: number;
  repaidVolume: bigint;
  liquidations: number;
  subscriptionCharges: number;
  subscriptionVolume: bigint;
  sendCount: number;
  sendVolume: bigint;
  claimCount: number;
  payoutCount: number;
  payoutVolume: bigint;
  collectionsRuns: number;
  creReports: number;
  newBuyers: number;
  newMerchants: number;
  open: bigint | null;
  high: bigint | null;
  low: bigint | null;
  close: bigint | null;
};

export type CollectionRun = {
  id: string;
  tasks: number;
  executed: number;
  skipped: number;
  transmitter: string;
  timestamp: number;
  blockNumber: number;
  txHash: string;
};

export type CollectionTask = {
  id: string;
  action: number;
  actionName: "COLLECT_INSTALLMENT" | "CHARGE_SUBSCRIPTION" | "LIQUIDATE" | "UNKNOWN";
  targetId: bigint;
  executed: boolean;
  amount: bigint | null;
  reason: string | null;
  reasonAction: ReasonAction | null;
  have: bigint | null;
  need: bigint | null;
  plan_id: string | null;
  subscription_id: string | null;
  timestamp: number;
  blockNumber: number;
  txHash: string;
};

export type CreReport = {
  id: string;
  workflow: "collections" | "underwrite";
  receiver: string;
  forwarder: string;
  workflowExecutionId: string;
  reportId: string;
  result: boolean;
  transmitter: string;
  timestamp: number;
  blockNumber: number;
  txHash: string;
};

/** Envio's `_meta` for one chain. */
export type IndexerStatus = {
  chainId: number;
  progressBlock: number;
  sourceBlock: number | null;
  eventsProcessed: number | null;
  isReady: boolean;
  readyAt: string | null;
  startBlock: number | null;
};

import type { CheckoutMode } from "polarispay-sdk";

export type InstallmentStatus = "paid" | "due" | "upcoming" | "failed";

/**
 * An order moves forward only: awaiting_payment → paid, or → needs_review
 * when Polaris reports a payment that doesn't match it. Nothing a browser
 * sends can move it; only a verified webhook does (see transitions.ts).
 */
export type OrderStatus = "awaiting_payment" | "paid" | "needs_review";

export type PaymentMethod = "polaris" | "wallet";

export interface OrderLine {
  productId: string;
  optionId: string;
  name: string;
  optionLabel: string;
  optionValue: string;
  image: string;
  /** Integer cents, per unit (per period for a subscription). */
  unitPrice: number;
  quantity: number;
  recurring?: "month";
}

export interface Address {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface Contact {
  email: string;
  phone?: string;
}

export interface PlanInstallmentRecord {
  index: number;
  /** Cents, as shown: the step between two rounded running totals, so the rows add up to the plan total. */
  amount: number;
  dueAt: string;
  status: InstallmentStatus;
  paidAt?: string | null;
}

export interface OrderPlan {
  planId: string;
  intervalSeconds: number;
  status: "active" | "past_due" | "completed" | "liquidated";
  /** Cents: what Halcyon was paid at opening, the buyer's interest, and what the buyer repays. Absent on plans stored before they were kept. */
  principal?: number;
  interest?: number;
  total?: number;
  installments: PlanInstallmentRecord[];
}

export interface OrderSubscription {
  subscriptionId: string;
  interval: "week" | "month";
  intervalCount: number;
  nextChargeAt: string;
  periodsCharged: number;
  status: "active" | "canceled";
  canceledAt?: string;
}

export interface ReceivedEvent {
  id: string;
  type: string;
  /** ISO 8601, when Polaris created the event. */
  createdAt: string;
  receivedAt: string;
  summary: string;
  outcome: "applied" | "flagged";
}

/** One SDK call, recorded for the "Built with Polaris" drawer. Never holds a key. */
export interface SdkCall {
  at: string;
  side: "server" | "browser";
  call: string;
  args?: unknown;
  result?: unknown;
  error?: string;
}

export interface Order {
  /** The order's address on this store: /orders/{id}. Reading the buyer's details also needs the access token. */
  id: string;
  /**
   * The reference Polaris and the chain see: the session's orderId, and the
   * orderId pay() signs for (it is written on chain in PaymentMade). Never
   * the order id, so an indexer of Polaris payments learns nothing it can
   * read an order with. Orders stored before it existed use their id.
   */
  payRef?: string;
  /**
   * Proof that a browser placed this order: set as an HttpOnly cookie when
   * the order is created, and needed to see the buyer's name, email and
   * address. Never sent to a browser in JSON (see orders/access.ts).
   */
  accessToken?: string;
  /** Set on the copy a browser gets without the access token: the buyer's details are masked or empty. */
  redacted?: boolean;
  number: string;
  createdAt: string;
  updatedAt: string;
  status: OrderStatus;
  statusReason?: string;
  kind: "one_time" | "subscription";
  lines: OrderLine[];
  subtotal: number;
  shipping: number;
  total: number;
  contact: Contact;
  address: Address;
  payment: {
    method: PaymentMethod;
    /** What the buyer picked on the store's checkout; the hosted checkout may still change it. */
    requestedMode?: CheckoutMode;
    /** What Polaris reported: the mode actually paid in. */
    mode?: CheckoutMode | "direct";
    sessionId?: string;
    sessionUrl?: string;
    sessionExpiresAt?: string;
    sessionAttempt: number;
    /** The mode the current session was opened with; a new mode needs a new session. */
    sessionMode?: CheckoutMode;
    /** The last time the store asked Polaris for the session (sessions.retrieve), to keep that to one call per 10 s. */
    lastSyncedAt?: string;
    paidAt?: string;
    payer?: string;
    txHash?: string;
    paymentId?: string;
    /** A second payment arrived for this order after it was paid: the store owes it back. */
    refundDue?: boolean;
    refundReason?: string;
  };
  plan?: OrderPlan;
  subscription?: OrderSubscription;
  events: ReceivedEvent[];
  sdkLog: SdkCall[];
}

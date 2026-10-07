/**
 * What a sealed receipt says: what was bought. The chain already shows who
 * paid whom, how much and when; this is the part it doesn't (the merchant's
 * description, the line items, the order reference, the plan's schedule).
 *
 * Amounts are dollar strings ("200.00"), the way the API writes them.
 */

export type ReceiptKind =
  /** Paid in full. */
  | "payment"
  /** A Pay in 4 plan opened. */
  | "plan"
  /** A subscription started. */
  | "subscription"
  /** One period of a subscription charged. Refers to its subscription's receipt. */
  | "subscription-charge"
  /** One instalment of a plan collected. Refers to its plan's receipt. */
  | "instalment";

export type ReceiptLineItem = { name: string; quantity: number; unitAmount: string };

export type ReceiptBody = {
  v: 1;
  kind: ReceiptKind;
  /** The merchant's name as Polaris knows it. */
  merchant: string;
  /** What was bought, in the merchant's words; null when the receipt only points at another (an instalment). */
  description: string | null;
  lineItems: ReceiptLineItem[];
  /** This payment's amount (a plan's principal, a period's price). */
  amount: string;
  currency: "USD";
  /** The merchant's own order reference. */
  orderId: string | null;
  /** Pay in 4: the schedule as it opened. */
  plan: { installments: number; intervalSeconds: number; total: string; schedule: Array<{ index: number; amount: string; dueAt: string }> } | null;
  /** A subscription's billing period ("month", 1). */
  subscription: { interval: string; intervalCount: number } | null;
  /** An instalment: which one, of how many. */
  installment: { index: number; of: number } | null;
  /** A subscription charge: which period (1 is the first). */
  period: number | null;
  /** The receipt this one belongs to: an instalment's plan, a charge's subscription. */
  refersTo: string | null;
  /** When it settled (ISO-8601). */
  at: string;
  txHash: string | null;
};

const KINDS: readonly ReceiptKind[] = ["payment", "plan", "subscription", "subscription-charge", "instalment"];

const isString = (v: unknown): v is string => typeof v === "string";
const orNull = <T>(v: unknown, check: (x: unknown) => x is T): T | null => (check(v) ? v : null);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A receipt body with every field, from a partial one (what a sealer fills in). */
export function receiptBody(fields: Pick<ReceiptBody, "kind" | "merchant" | "amount" | "at"> & Partial<ReceiptBody>): ReceiptBody {
  return {
    v: 1,
    kind: fields.kind,
    merchant: fields.merchant,
    description: fields.description ?? null,
    lineItems: fields.lineItems ?? [],
    amount: fields.amount,
    currency: "USD",
    orderId: fields.orderId ?? null,
    plan: fields.plan ?? null,
    subscription: fields.subscription ?? null,
    installment: fields.installment ?? null,
    period: fields.period ?? null,
    refersTo: fields.refersTo ?? null,
    at: fields.at,
    txHash: fields.txHash ?? null,
  };
}

/** Checks an opened receipt's shape; throws on anything that isn't a v1 receipt. */
export function parseReceiptBody(value: unknown): ReceiptBody {
  if (!isObject(value) || value.v !== 1) throw new Error("Not a v1 receipt");
  const kind = value.kind as ReceiptKind;
  if (!KINDS.includes(kind)) throw new Error("Unknown receipt kind");
  if (!isString(value.merchant) || !isString(value.amount) || !isString(value.at)) throw new Error("A receipt needs a merchant, an amount and a time");
  const lineItems = Array.isArray(value.lineItems)
    ? value.lineItems.filter(
        (li): li is ReceiptLineItem => isObject(li) && isString(li.name) && typeof li.quantity === "number" && isString(li.unitAmount),
      )
    : [];
  return receiptBody({
    kind,
    merchant: value.merchant,
    amount: value.amount,
    at: value.at,
    description: orNull(value.description, isString),
    lineItems: lineItems.map((li) => ({ name: li.name, quantity: li.quantity, unitAmount: li.unitAmount })),
    orderId: orNull(value.orderId, isString),
    plan: isObject(value.plan) ? (value.plan as ReceiptBody["plan"]) : null,
    subscription: isObject(value.subscription) ? (value.subscription as ReceiptBody["subscription"]) : null,
    installment: isObject(value.installment) ? (value.installment as ReceiptBody["installment"]) : null,
    period: typeof value.period === "number" ? value.period : null,
    refersTo: orNull(value.refersTo, isString),
    txHash: orNull(value.txHash, isString),
  });
}

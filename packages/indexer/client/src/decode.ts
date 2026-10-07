/**
 * Turn Hasura rows into the client's types. Hasura returns `numeric`
 * (BigInt) columns as JSON strings (Envio sets
 * HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES); numbers are accepted too, in case
 * a deployment does not stringify.
 *
 * `BIGINT_FIELDS` lists every BigInt column each fragment selects; the test
 * suite checks it against schema.graphql, so a new BigInt field cannot be
 * left as a string by mistake.
 */

import type {
  Activity,
  Buyer,
  BuyerDay,
  CollectionRun,
  CollectionTask,
  CreReport,
  Customer,
  IndexerStatus,
  Installment,
  Merchant,
  MerchantDay,
  Order,
  Payment,
  Payout,
  Plan,
  Protocol,
  ProtocolDay,
  Repayment,
  ScoreEvent,
  Send,
  Subscription,
} from "./types.ts";

export const BIGINT_FIELDS = {
  Merchant: [
    "maxOrderValue",
    "grossVolume",
    "feeVolume",
    "netVolume",
    "payNowVolume",
    "planVolume",
    "subscriptionVolume",
    "outstanding",
    "atRiskOutstanding",
    "mrr",
    "balance",
    "payoutVolume",
  ],
  Payment: ["amount", "fee", "net", "quotedAmount"],
  Installment: ["amount", "paid"],
  Plan: ["loanId", "principal", "totalOwed", "interest", "installmentAmount", "totalRepaid", "outstanding", "recovered", "loss"],
  Repayment: ["amount"],
  Subscription: ["subId", "pricePerPeriod", "totalCharged"],
  Payout: ["amount"],
  Customer: ["volume"],
  MerchantDay: [
    "grossVolume",
    "feeVolume",
    "netVolume",
    "payNowVolume",
    "planVolume",
    "subscriptionVolume",
    "repaidVolume",
    "payoutVolume",
    "open",
    "high",
    "low",
    "close",
    "balanceOpen",
    "balanceHigh",
    "balanceLow",
    "balanceClose",
  ],
  Order: ["quotedAmount", "amount"],
  Activity: ["cursor", "amount", "fee", "principal", "remaining", "recovered"],
  Buyer: ["baseLimit", "collateral", "creditLimit", "activeDebt", "available", "spent", "sentVolume", "claimedVolume"],
  ScoreEvent: [],
  BuyerDay: ["spent", "repaid"],
  Send: ["amount"],
  Protocol: [
    "grossVolume",
    "feeVolume",
    "payNowVolume",
    "principalOriginated",
    "outstanding",
    "repaidVolume",
    "lossVolume",
    "subscriptionVolume",
    "sendVolume",
    "claimVolume",
    "payoutVolume",
  ],
  ProtocolDay: [
    "grossVolume",
    "feeVolume",
    "principalOriginated",
    "repaidVolume",
    "subscriptionVolume",
    "sendVolume",
    "payoutVolume",
    "open",
    "high",
    "low",
    "close",
  ],
  CollectionRun: [],
  CollectionTask: ["targetId", "amount", "have", "need"],
  CreReport: [],
} as const satisfies Record<string, readonly string[]>;

export type Raw = Record<string, unknown>;

/** A Hasura numeric (string or number) as a bigint. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new TypeError(`${value} is not an integer`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new TypeError(`Cannot read ${JSON.stringify(value)} as a BigInt`);
}

function row<T>(raw: Raw, bigints: readonly string[]): T {
  const out: Raw = { ...raw };
  for (const key of bigints) {
    const v = out[key];
    if (v !== null && v !== undefined) out[key] = toBigInt(v);
  }
  return out as T;
}

const rows = <T>(list: unknown, decode: (r: Raw) => T): T[] => (Array.isArray(list) ? list.map((r) => decode(r as Raw)) : []);

export const decode = {
  merchant: (r: Raw) => row<Merchant>(r, BIGINT_FIELDS.Merchant),
  payment: (r: Raw) => row<Payment>(r, BIGINT_FIELDS.Payment),
  installment: (r: Raw) => row<Installment>(r, BIGINT_FIELDS.Installment),
  plan: (r: Raw): Plan => ({ ...row<Plan>(r, BIGINT_FIELDS.Plan), installments: rows(r.installments, decode.installment) }),
  repayment: (r: Raw) => row<Repayment>(r, BIGINT_FIELDS.Repayment),
  subscription: (r: Raw) => row<Subscription>(r, BIGINT_FIELDS.Subscription),
  payout: (r: Raw) => row<Payout>(r, BIGINT_FIELDS.Payout),
  customer: (r: Raw) => row<Customer>(r, BIGINT_FIELDS.Customer),
  merchantDay: (r: Raw) => row<MerchantDay>(r, BIGINT_FIELDS.MerchantDay),
  order: (r: Raw) => row<Order>(r, BIGINT_FIELDS.Order),
  activity: (r: Raw) => row<Activity>(r, BIGINT_FIELDS.Activity),
  buyer: (r: Raw) => row<Buyer>(r, BIGINT_FIELDS.Buyer),
  scoreEvent: (r: Raw) => row<ScoreEvent>(r, BIGINT_FIELDS.ScoreEvent),
  buyerDay: (r: Raw) => row<BuyerDay>(r, BIGINT_FIELDS.BuyerDay),
  send: (r: Raw) => row<Send>(r, BIGINT_FIELDS.Send),
  protocol: (r: Raw) => row<Protocol>(r, BIGINT_FIELDS.Protocol),
  protocolDay: (r: Raw) => row<ProtocolDay>(r, BIGINT_FIELDS.ProtocolDay),
  collectionRun: (r: Raw) => row<CollectionRun>(r, BIGINT_FIELDS.CollectionRun),
  collectionTask: (r: Raw) => row<CollectionTask>(r, BIGINT_FIELDS.CollectionTask),
  creReport: (r: Raw) => row<CreReport>(r, BIGINT_FIELDS.CreReport),
  rows,
  /** `_meta` is a list (one row per chain) in Envio's Hasura; take the chain asked for, or the first. */
  status: (meta: unknown, chainId?: number): IndexerStatus | null => {
    const list = (Array.isArray(meta) ? meta : meta ? [meta] : []) as Raw[];
    const r = list.find((m) => chainId === undefined || Number(m.chainId) === chainId) ?? null;
    if (!r) return null;
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      chainId: Number(r.chainId),
      progressBlock: Number(r.progressBlock),
      sourceBlock: num(r.sourceBlock),
      eventsProcessed: num(r.eventsProcessed),
      isReady: Boolean(r.isReady),
      readyAt: (r.readyAt as string | null | undefined) ?? null,
      startBlock: num(r.startBlock),
    };
  },
};

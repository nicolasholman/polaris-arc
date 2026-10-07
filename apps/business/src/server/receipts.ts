import "server-only";

import {
  SEALED_DESCRIPTION,
  type CheckoutSessionRecord,
  type MerchantRecord,
  type PaymentRecord,
  type PlanRecord,
  type SealedReceiptRecord,
  type SubscriptionRecord,
} from "@polaris/db";
import {
  inboxRegistrationMessage,
  readRequestStaleness,
  receiptBody,
  receiptsReadMessage,
  sealReceipt,
  type ReceiptBody,
} from "@polaris/receipts";
import { getAddress, isAddress, isHex, verifyMessage, type Address, type Hex } from "viem";

import { formatCents, formatUnits, installmentAmounts } from "./chain/money";
import { getDb } from "./db";
import { HttpError } from "./http";

/**
 * Receipts only the buyer can read (docs/research/mera.md §16).
 *
 * The buyer's Face ID derives an X25519 inbox key pair next to their wallet
 * key (@polaris/receipts). They register the public half here, with their
 * account's signature over it. From then on, what they bought (the
 * checkout's description and line items, the order reference, the plan's
 * schedule) is sealed to that key the moment it settles (RFC 9180 HPKE,
 * with the buyer and the receipt id bound in as AAD), and the plaintext is
 * dropped from the session, the payment and the plan. What stays in the
 * clear is what the chain shows anyway (who, whom, how much, when) and the
 * merchant's own order id and metadata.
 *
 * Buyers without an inbox (an email account, which has no Face ID key, or
 * a payer who never registered) keep today's records unchanged.
 */

const PUBLIC_KEY = /^0x[0-9a-fA-F]{64}$/;
const LIST_LIMIT = 200;

const merchantName = (m: MerchantRecord | null | undefined) => m?.businessName ?? "Polaris merchant";

function lineItemsOf(session: CheckoutSessionRecord | null): ReceiptBody["lineItems"] {
  if (!session || session.sealedAt) return [];
  return session.lineItems.map((li) => ({ name: li.name, quantity: li.quantity, unitAmount: formatCents(li.unitAmountCents) }));
}

/** The session's description while it is still in the clear, else null. */
function sessionDescription(session: CheckoutSessionRecord | null): string | null {
  return session && !session.sealedAt ? session.description : null;
}

/* ── The inbox ──────────────────────────────────────────────────────────── */

/** The buyer's registered inbox key, or null. */
export async function inboxFor(owner: Address | string): Promise<Hex | null> {
  return (await getDb().receiptInboxes.get(owner.toLowerCase()))?.publicKey ?? null;
}

function requireAddress(value: unknown, param: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new HttpError(400, "invalid_request", `${param} must be an address.`, { param });
  return getAddress(value);
}

function requireSignature(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length < 132) throw new HttpError(400, "invalid_request", "signature must be a hex signature.", { param: "signature" });
  return value;
}

/** True when `signature` is `address`'s EIP-191 signature over `message`. */
async function signedBy(address: Address, message: string, signature: Hex): Promise<boolean> {
  try {
    return await verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}

/**
 * `POST /api/receipts/inbox`: `{ address, inboxPublicKey, signature }`, the
 * signature being the account's over `Polaris receipts key <inboxPublicKey>`.
 * Registers (or re-registers) the key, then seals whatever this buyer's
 * records still hold in the clear.
 */
export async function registerInbox(input: Record<string, unknown>): Promise<{ address: Address; inboxPublicKey: Hex; registeredAt: string; sealed: number }> {
  const address = requireAddress(input.address, "address");
  if (typeof input.inboxPublicKey !== "string" || !PUBLIC_KEY.test(input.inboxPublicKey)) {
    throw new HttpError(400, "invalid_request", "inboxPublicKey must be 0x and 64 hex characters (32 bytes).", { param: "inboxPublicKey" });
  }
  const publicKey = input.inboxPublicKey.toLowerCase() as Hex;
  const signature = requireSignature(input.signature);
  if (!(await signedBy(address, inboxRegistrationMessage(publicKey), signature))) {
    throw new HttpError(401, "bad_signature", "That signature isn't this account's over this key.");
  }
  const db = getDb();
  const now = new Date().toISOString();
  const id = address.toLowerCase();
  const existing = await db.receiptInboxes.get(id);
  const record = { id, publicKey, signature, registeredAt: existing?.publicKey === publicKey ? existing.registeredAt : now, updatedAt: now };
  await db.receiptInboxes.upsert(record);
  const sealed = await sealBacklog(address, publicKey);
  return { address, inboxPublicKey: publicKey, registeredAt: record.registeredAt, sealed };
}

/**
 * `POST /api/receipts`: `{ address, issuedAt, signature }`, the signature
 * being the account's over `receiptsReadMessage(address, issuedAt)`, at most
 * five minutes old. The buyer's sealed receipts, newest first: ciphertext
 * only their Face ID opens.
 */
export async function readReceipts(input: Record<string, unknown>, nowSeconds = Math.floor(Date.now() / 1000)) {
  const address = requireAddress(input.address, "address");
  const issuedAt = input.issuedAt;
  if (typeof issuedAt !== "number") throw new HttpError(400, "invalid_request", "issuedAt must be unix seconds.", { param: "issuedAt" });
  const stale = readRequestStaleness(issuedAt, nowSeconds);
  if (stale) throw new HttpError(401, "stale_request", `This request is ${stale}. Sign a new one.`);
  const signature = requireSignature(input.signature);
  if (!(await signedBy(address, receiptsReadMessage(address, issuedAt), signature))) {
    throw new HttpError(401, "bad_signature", "That signature isn't this account's.");
  }
  const db = getDb();
  const owner = address.toLowerCase();
  const [inbox, rows] = await Promise.all([db.receiptInboxes.get(owner), db.receipts.find({ owner }, { orderBy: "createdAt", direction: "desc", limit: LIST_LIMIT })]);
  return {
    address,
    inboxPublicKey: inbox?.publicKey ?? null,
    receipts: rows.map((r) => ({ id: r.id, kind: r.kind, enc: r.enc, ct: r.ct, txHash: r.txHash, amountUnits: r.amountUnits, createdAt: r.createdAt })),
  };
}

/** What the public buyer book says about receipts: which rows have one, never what's in it. */
export async function receiptIndex(owner: Address) {
  const db = getDb();
  const who = owner.toLowerCase();
  const [inbox, rows] = await Promise.all([db.receiptInboxes.get(who), db.receipts.find({ owner: who }, { orderBy: "createdAt", direction: "desc", limit: LIST_LIMIT })]);
  return {
    inbox: inbox !== null,
    receipts: rows.map((r) => ({ id: r.id, kind: r.kind, txHash: r.txHash, amountUnits: r.amountUnits, createdAt: r.createdAt })),
  };
}

/* ── Sealing ────────────────────────────────────────────────────────────── */

type Seal = {
  owner: Address;
  id: string;
  body: ReceiptBody;
  txHash: Hex | null;
  amountUnits: string | null;
  merchantId: string | null;
};

/**
 * Seal one receipt to `inbox` and store it, once: a receipt that already
 * exists is kept as it is (a log handled twice must not reseal it from
 * records that were already scrubbed). Returns the receipt id.
 */
async function store(inbox: Hex, s: Seal): Promise<string> {
  const db = getDb();
  if (await db.receipts.get(s.id)) return s.id;
  const sealed = await sealReceipt(inbox, s.owner, s.id, s.body);
  const record: SealedReceiptRecord = {
    id: s.id,
    owner: s.owner.toLowerCase(),
    kind: s.body.kind,
    enc: sealed.enc,
    ct: sealed.ct,
    txHash: s.txHash,
    amountUnits: s.amountUnits,
    merchantId: s.merchantId,
    createdAt: s.body.at,
  };
  try {
    await db.receipts.insert(record);
  } catch {
    // Another handler sealed it in the meantime; theirs stands.
  }
  return s.id;
}

/**
 * Seal at settlement, or return null to keep the plaintext: when the buyer
 * has no inbox, or sealing failed (logged; the record keeps its text, and
 * the next registration seals it).
 */
export async function sealIfInbox(owner: Address, make: () => Seal | Promise<Seal>): Promise<string | null> {
  const inbox = await inboxFor(owner);
  if (!inbox) return null;
  try {
    return await store(inbox, await make());
  } catch (error) {
    console.error(`[receipts] couldn't seal a receipt for ${owner}; its record keeps the text for now`, error);
    return null;
  }
}

/**
 * Drop a completed session's description and line items, once its receipt
 * is sealed: from the session, and from the copy of the create response an
 * Idempotency-Key replays (sessions/idempotency.ts).
 */
export async function scrubSession(sessionId: string, at: string): Promise<void> {
  const db = getDb();
  await db.sessions.update(sessionId, (s) => (s.sealedAt ? s : { ...s, description: SEALED_DESCRIPTION, lineItems: [], sealedAt: at }));
  for (const replay of await db.idempotency.find({ resourceId: sessionId })) {
    await db.idempotency.update(replay.id, (r) => {
      if (!r.body) return r;
      const body = JSON.parse(r.body) as Record<string, unknown>;
      if (body.description === SEALED_DESCRIPTION) return r;
      return { ...r, body: JSON.stringify({ ...body, description: SEALED_DESCRIPTION, lineItems: [] }) };
    });
  }
}

/* What each settlement seals. */

export function paymentReceipt(p: { owner: Address; paymentId: string; merchant: MerchantRecord; session: CheckoutSessionRecord | null; amount: bigint; orderId: string; txHash: Hex; at: string }): Seal {
  return {
    owner: p.owner,
    id: p.paymentId,
    txHash: p.txHash,
    amountUnits: p.amount.toString(),
    merchantId: p.merchant.id,
    body: receiptBody({
      kind: "payment",
      merchant: merchantName(p.merchant),
      description: sessionDescription(p.session),
      lineItems: lineItemsOf(p.session),
      amount: formatUnits(p.amount),
      orderId: p.session?.orderId ?? p.orderId,
      at: p.at,
      txHash: p.txHash,
    }),
  };
}

export function planReceipt(p: { plan: PlanRecord; merchant: MerchantRecord; session: CheckoutSessionRecord | null; description: string | null }): Seal {
  const total = BigInt(p.plan.totalOwedUnits);
  return {
    owner: p.plan.borrower,
    id: `plan:${p.plan.id}`,
    txHash: p.plan.openedTxHash,
    amountUnits: p.plan.principalUnits,
    merchantId: p.merchant.id,
    body: receiptBody({
      kind: "plan",
      merchant: merchantName(p.merchant),
      description: p.description,
      lineItems: lineItemsOf(p.session),
      amount: formatUnits(BigInt(p.plan.principalUnits)),
      orderId: p.plan.orderId,
      plan: {
        installments: p.plan.installments,
        intervalSeconds: p.plan.intervalSeconds,
        total: formatUnits(total),
        schedule: installmentAmounts(total, p.plan.installments).map((amount, i) => ({
          index: i + 1,
          amount: formatUnits(amount),
          dueAt: new Date((p.plan.startedAt + (i + 1) * p.plan.intervalSeconds) * 1000).toISOString(),
        })),
      },
      at: p.plan.createdAt,
      txHash: p.plan.openedTxHash,
    }),
  };
}

export function instalmentReceipt(p: { plan: PlanRecord; merchant: MerchantRecord; index: number; amount: bigint; txHash: Hex; at: string }): Seal {
  return {
    owner: p.plan.borrower,
    id: `instalment:${p.plan.id}:${p.index}`,
    txHash: p.txHash,
    amountUnits: p.amount.toString(),
    merchantId: p.merchant.id,
    body: receiptBody({
      kind: "instalment",
      merchant: merchantName(p.merchant),
      amount: formatUnits(p.amount),
      orderId: p.plan.orderId,
      installment: { index: p.index, of: p.plan.installments },
      // What was bought lives in the plan's receipt; this one points at it.
      refersTo: p.plan.receiptId ?? `plan:${p.plan.id}`,
      at: p.at,
      txHash: p.txHash,
    }),
  };
}

export function subscriptionReceipt(p: { sub: SubscriptionRecord; merchant: MerchantRecord; session: CheckoutSessionRecord; txHash: Hex | null; at: string }): Seal {
  return {
    owner: p.sub.subscriber,
    id: `subscription:${p.sub.id}`,
    txHash: p.txHash,
    amountUnits: p.sub.priceUnits,
    merchantId: p.merchant.id,
    body: receiptBody({
      kind: "subscription",
      merchant: merchantName(p.merchant),
      description: sessionDescription(p.session),
      lineItems: lineItemsOf(p.session),
      amount: formatUnits(BigInt(p.sub.priceUnits)),
      orderId: p.session.orderId ?? p.sub.orderId,
      subscription: p.session.subscription ? { interval: p.session.subscription.interval, intervalCount: p.session.subscription.intervalCount } : null,
      at: p.at,
      txHash: p.txHash,
    }),
  };
}

export function chargeReceipt(p: { sub: SubscriptionRecord; merchant: MerchantRecord; paymentId: string; period: number; amount: bigint; description: string | null; txHash: Hex; at: string }): Seal {
  return {
    owner: p.sub.subscriber,
    id: p.paymentId,
    txHash: p.txHash,
    amountUnits: p.amount.toString(),
    merchantId: p.merchant.id,
    body: receiptBody({
      kind: "subscription-charge",
      merchant: merchantName(p.merchant),
      // The subscription's receipt carries what it is; a charge from before it was sealed carries its own line.
      description: p.sub.receiptId ? null : p.description,
      amount: formatUnits(p.amount),
      orderId: p.sub.orderId,
      period: p.period,
      refersTo: p.sub.receiptId ?? null,
      at: p.at,
      txHash: p.txHash,
    }),
  };
}

/* ── The backlog: what settled before the buyer registered ──────────────── */

/**
 * Seal every record of this buyer that still holds a description in the
 * clear (it settled before they registered, or in the moment between
 * account creation and registration), and drop the plaintext. Subscriptions
 * first, so their charges can point at them. Returns how many it sealed.
 */
export async function sealBacklog(owner: Address, inbox: Hex): Promise<number> {
  const db = getDb();
  const who = owner.toLowerCase();
  let sealed = 0;
  const merchants = new Map<string, MerchantRecord | null>();
  const merchantOf = async (id: string) => {
    if (!merchants.has(id)) merchants.set(id, await db.merchants.get(id));
    return merchants.get(id) ?? null;
  };
  const sessionOf = async (id: string | null) => (id ? await db.sessions.get(id) : null);

  for (const sub of await db.subscriptions.find({ subscriber: who })) {
    if (sub.receiptId || !sub.sessionId) continue;
    const [merchant, session] = await Promise.all([merchantOf(sub.merchantId), sessionOf(sub.sessionId)]);
    if (!merchant || !session || session.status !== "complete" || session.sealedAt) continue;
    const id = await store(inbox, subscriptionReceipt({ sub, merchant, session, txHash: session.payment?.txHash ?? null, at: session.completedAt ?? sub.createdAt }));
    await db.subscriptions.update(sub.id, (s) => ({ ...s, receiptId: id }));
    await scrubSession(session.id, new Date().toISOString());
    sealed++;
  }

  for (const p of await db.payments.find({ payer: who })) {
    if (p.receiptId || p.mismatch) continue;
    const merchant = await merchantOf(p.merchantId);
    if (!merchant) continue;
    const session = await sessionOf(p.sessionId);
    const clear = p.description === SEALED_DESCRIPTION ? null : p.description;
    let seal: Seal;
    if (p.kind === "later") {
      const plan = await db.plans.get(p.id.replace(/^plan:/, ""));
      if (!plan) continue;
      seal = planReceipt({ plan, merchant, session, description: sessionDescription(session) ?? (plan.description === SEALED_DESCRIPTION ? null : plan.description) });
    } else if (p.kind === "subscription") {
      const [, subId, period] = p.id.split(":");
      const sub = subId ? await db.subscriptions.get(subId) : null;
      if (!sub) continue;
      seal = chargeReceipt({ sub, merchant, paymentId: p.id, period: Number(period) || 1, amount: BigInt(p.amountUnits), description: clear, txHash: p.txHash, at: p.createdAt });
    } else {
      seal = paymentReceipt({ owner, paymentId: p.id, merchant, session, amount: BigInt(p.amountUnits), orderId: p.orderId, txHash: p.txHash, at: p.createdAt });
      if (!seal.body.description) seal.body.description = clear;
    }
    const id = await store(inbox, seal);
    await sealRecords(p, id);
    if (session && session.status === "complete") await scrubSession(session.id, new Date().toISOString());
    sealed++;
  }
  return sealed;
}

/** Point a payment (and a plan's own record) at its receipt and drop their descriptions. */
async function sealRecords(p: PaymentRecord, receiptId: string): Promise<void> {
  const db = getDb();
  await db.payments.update(p.id, (x) => ({ ...x, description: SEALED_DESCRIPTION, receiptId }));
  if (p.kind === "later") await db.plans.update(p.id.replace(/^plan:/, ""), (x) => ({ ...x, description: SEALED_DESCRIPTION, receiptId }));
}

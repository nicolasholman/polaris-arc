/**
 * The records Polaris for Business keeps, and the collections that hold them.
 *
 * Money on chain is AUSD base units (6 decimals) as decimal strings, never
 * floats. Session prices are integer cents, the unit merchants think in.
 * Times are ISO-8601 UTC strings unless a field says `Ms` (epoch millis) or
 * `At` on a chain record (unix seconds, as the contracts store them).
 *
 * Secrets never appear in a record except where the server must use them:
 * a secret key is kept only as its hash, and a webhook endpoint keeps its
 * signing secret because every delivery is signed with it.
 */

import { newId } from "./keys.ts";
import type { CollectionSpec, Store } from "./store/types.ts";
import type { WebhookEventType } from "./webhooks.ts";

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type IsoDate = string;

/* ── Merchants ──────────────────────────────────────────────────────────── */

export type RegistrationState =
  /** Nothing signed yet. */
  | "none"
  /** registerFor sent; waiting for the block. */
  | "submitted"
  /** In MerchantRegistry, not yet allowed to originate Pay in 4. */
  | "registered"
  /** Registered and activated with a cap. */
  | "active"
  | "failed";

export type MerchantRecord = {
  /** The Privy user id (`did:privy:…`), or `dev:<address>` for a local seed. */
  id: string;
  /** What webhooks and the public API call this merchant: `mer_…`. */
  publicId: string;
  businessName: string | null;
  /** The Privy embedded wallet: where money lands and what signs payouts. */
  walletAddress: Address | null;
  /** Privy's id for that wallet (automatic payouts address it by id). */
  walletId: string | null;
  email: string | null;
  createdAt: IsoDate;
  registration: {
    state: RegistrationState;
    txHash: Hex | null;
    activationTxHash: Hex | null;
    /** The per-order cap set on activation, in AUSD base units. */
    maxOrderUnits: string | null;
    error: string | null;
    updatedAt: IsoDate | null;
  };
  autoPayouts: {
    enabled: boolean;
    payoutAddress: Address | null;
    /** The Privy policy that pins our payout signer to `payoutAddress`. */
    policyId: string | null;
    hourUtc: number;
    nextRunAt: IsoDate | null;
    lastRunAt: IsoDate | null;
    lastError: string | null;
  };
  /** Seeded with sample data because no chain was configured. */
  sample: boolean;
  /** Sample mode only: the balance the sample book implies. */
  sampleBalanceCents: number;
};

/** A new merchant as the dashboard (first Privy session) or a local seed creates one. */
export function newMerchantRecord(input: {
  id: string;
  walletAddress: Address | null;
  walletId?: string | null;
  email?: string | null;
  businessName?: string | null;
  sample?: boolean;
  sampleBalanceCents?: number;
  now?: Date;
}): MerchantRecord {
  return {
    id: input.id,
    publicId: newId("mer", 16),
    businessName: input.businessName ?? null,
    walletAddress: input.walletAddress,
    walletId: input.walletId ?? null,
    email: input.email ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
    registration: { state: "none", txHash: null, activationTxHash: null, maxOrderUnits: null, error: null, updatedAt: null },
    autoPayouts: { enabled: false, payoutAddress: null, policyId: null, hourUtc: 17, nextRunAt: null, lastRunAt: null, lastError: null },
    sample: input.sample ?? false,
    sampleBalanceCents: input.sampleBalanceCents ?? 0,
  };
}

/* ── API keys ───────────────────────────────────────────────────────────── */

export type ApiKeyRecord = {
  id: string;
  merchantId: string;
  name: string;
  livemode: boolean;
  /** Public by design; stored in full. */
  publishableKey: string;
  /** `sk_test_…a1b2`. */
  secretHint: string;
  /** keys.ts `hashSecretKey`. The secret itself is never stored. */
  secretHash: string;
  createdAt: IsoDate;
  lastUsedAt: IsoDate | null;
  revokedAt: IsoDate | null;
};

/* ── Checkout sessions ──────────────────────────────────────────────────── */

export type CheckoutMode = "now" | "later" | "subscribe";
export type SubscriptionInterval = "day" | "week" | "month" | "year";

export type SessionPayment = {
  mode: CheckoutMode;
  payer: Address;
  txHash: Hex;
  chainId: number;
  paymentId: Hex | null;
  planId: string | null;
  subscriptionId: string | null;
};

/**
 * A settlement of a session's order that didn't match what the session asked
 * for: another amount, a mode it doesn't offer, another subscription plan.
 * It is recorded, it never completes the session, and it sends no success
 * webhook, so a merchant trusting `paymentStatus` never ships for less.
 */
export type SessionMismatch = {
  mode: CheckoutMode;
  payer: Address;
  txHash: Hex;
  /** What was wrong, for the dashboard. */
  reason: string;
  /** What the session asked for and what arrived, in AUSD base units. */
  expectedUnits: string;
  gotUnits: string;
  at: IsoDate;
};

export type CheckoutSessionRecord = {
  /** `cs_test_…`. */
  id: string;
  merchantId: string;
  livemode: boolean;
  status: "open" | "complete" | "expired";
  amountCents: number;
  currency: "USD";
  description: string;
  lineItems: Array<{ name: string; quantity: number; unitAmountCents: number }>;
  modes: CheckoutMode[];
  subscription: { interval: SubscriptionInterval; intervalCount: number } | null;
  successUrl: string;
  cancelUrl: string | null;
  orderId: string | null;
  metadata: Record<string, string>;
  createdAt: IsoDate;
  expiresAt: IsoDate;
  completedAt: IsoDate | null;
  /** The payment link this session was opened from, if any. */
  linkId: string | null;
  /** What the buyer signs against. Fixed at creation. */
  chain: {
    chainId: number;
    /** The merchant's wallet when the session was created. */
    merchant: Address;
    /** The on-chain order id: the merchant's orderId, else the session id. */
    orderId: string;
    /** keccak256(abi.encodePacked(merchant, orderId)): the Pay-now nonce and PolarisPayments payment id. */
    orderKey: Hex;
    /** PolarisPayments plan for "subscribe", created by the relayer. */
    subscriptionPlanId: string | null;
    /**
     * The price pinned on chain with `PolarisPayments.quoteOrder` before the
     * session (and so its order id) was handed out, so the order can only be
     * paid at exactly this price, by any path, relayed or not. Null when no
     * relayer was configured to pin it (development only).
     */
    quote?: { amountUnits: string; txHash: Hex | null; at: IsoDate } | null;
  };
  payment: SessionPayment | null;
  /** Settlements of this order that didn't match the session. */
  mismatches?: SessionMismatch[];
  /**
   * When the description and line items were sealed to the buyer and dropped
   * from this record (the buyer has a receipts inbox). Absent or null: the
   * plaintext is still here.
   */
  sealedAt?: IsoDate | null;
};

/**
 * What a record says in place of the description once it is sealed to the
 * buyer: the merchant's dashboard and API show this, and the order id and
 * metadata, which stay.
 */
export const SEALED_DESCRIPTION = "Sealed for the buyer";

/* ── Idempotency ────────────────────────────────────────────────────────── */

export type IdempotencyRecord = {
  /** `<scope>:<key>`, e.g. `sessions:<merchantId>:<Idempotency-Key>`. */
  id: string;
  requestHash: string;
  state: "in_progress" | "done";
  status: number | null;
  /** The response body, as sent. */
  body: string | null;
  /** The id of what the response created (a session's `cs_…`), so a later change can reach its stored copy. */
  resourceId?: string | null;
  createdAt: IsoDate;
  /** Epoch ms after which the key may be reused. */
  expiresAtMs: number;
};

/* ── The relayer ────────────────────────────────────────────────────────── */

export type RelayKind =
  | "pay"
  | "payWithAuthorization"
  | "openPlan"
  | "subscribe"
  | "send"
  | "claim"
  | "cancelSend"
  | "repay"
  | "reauthorize"
  | "lockCollateral"
  | "withdrawCollateral"
  | "cancelSubscription"
  | "transfer"
  | "registerMerchant"
  | "activateMerchant"
  | "createSubscriptionPlan"
  | "quoteOrder"
  | "payout"
  | "createSplit"
  | "payShare"
  | "closeSplit";

export type RelayRecord = {
  /** A digest of the signed request: the same signatures relay once. */
  id: string;
  kind: RelayKind;
  state: "pending" | "submitted" | "confirmed" | "failed";
  /** Who signed (the buyer, sender, merchant). */
  signer: Address | null;
  to: Address;
  txHash: Hex | null;
  blockNumber: number | null;
  sessionId: string | null;
  merchantId: string | null;
  /** Ids the receipt yielded: paymentId, loanId, subId, … */
  result: Record<string, string> | null;
  error: { code: string; message: string } | null;
  /** The relayer account that sent it, and the nonce it used, to tell a dropped transaction from a slow one. */
  from?: Address | null;
  nonce?: number | null;
  /** When the reconciler last looked for its receipt; it pages through submitted relays by this. */
  checkedAt?: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

/* ── What the chain says happened ───────────────────────────────────────── */

export type PaymentRecord = {
  /**
   * PolarisPayments payment id (the order key) for Pay now, `plan:<loanId>`
   * for a Pay in 4 origination, `sub:<subId>:<period>` for a subscription charge.
   */
  id: string;
  merchantId: string;
  kind: "now" | "later" | "subscription";
  sessionId: string | null;
  linkId: string | null;
  /** The merchant's reference (session orderId), else the chain order id. */
  orderId: string;
  description: string;
  payer: Address;
  amountUnits: string;
  feeUnits: string;
  txHash: Hex;
  blockNumber: number;
  createdAt: IsoDate;
  /**
   * Why this payment didn't settle the session whose order it paid (see
   * `SessionMismatch`). The money is the merchant's either way; the order
   * is not paid.
   */
  mismatch?: string | null;
  /** The sealed receipt that holds this payment's description; `description` is then `SEALED_DESCRIPTION`. */
  receiptId?: string | null;
  sample?: boolean;
};

export type PlanState = "collecting" | "dunning" | "repaid" | "written_off";

export type PlanRecord = {
  /** PolarisLoanEngine loan id. */
  id: string;
  merchantId: string;
  sessionId: string | null;
  orderId: string;
  description: string;
  borrower: Address;
  principalUnits: string;
  totalOwedUnits: string;
  repaidUnits: string;
  installments: number;
  installmentsPaid: number;
  intervalSeconds: number;
  /** Unix seconds; instalment i (0-based) is due at startedAt + (i+1)·interval. */
  startedAt: number;
  state: PlanState;
  /** Failed collections of the current instalment. */
  attempts: number;
  lastFailure: { reason: string; at: IsoDate; nextAttemptAt: IsoDate | null } | null;
  /**
   * The borrower signed their approval again (PolarisCheckout.Reauthorized)
   * after a collection failed for a lost one, and the collection that
   * followed (the CRE collections run on its log trigger). Cleared by the
   * next failure. The app shows "collecting now" until `collected` is set.
   */
  reauthorized?: { at: IsoDate; txHash: Hex; collected: { at: IsoDate; txHash: Hex } | null } | null;
  openedTxHash: Hex;
  /** The sealed receipt that holds this plan's description; `description` is then `SEALED_DESCRIPTION`. */
  receiptId?: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  sample?: boolean;
};

export type SubscriptionRecord = {
  /** PolarisPayments subscription id. */
  id: string;
  merchantId: string;
  planId: string;
  subscriber: Address;
  priceUnits: string;
  periodSeconds: number;
  periodsCharged: number;
  /** Unix seconds. */
  nextChargeAt: number;
  status: "active" | "canceled" | "lapsed";
  orderId: string | null;
  sessionId: string | null;
  /** The sealed receipt of what was subscribed to (`subscription:<id>`), once sealed. */
  receiptId?: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type SubscriptionPlanRecord = {
  /** PolarisPayments plan id. */
  id: string;
  merchantId: string;
  merchant: Address;
  /** `<merchant>:<priceUnits>:<periodSeconds>`: one plan per price and period. */
  terms: string;
  priceUnits: string;
  periodSeconds: number;
  name: string;
  txHash: Hex | null;
  createdAt: IsoDate;
};

export type PayoutRecord = {
  id: string;
  merchantId: string;
  kind: "manual" | "automatic";
  state: "queued" | "submitted" | "paid" | "failed";
  amountUnits: string;
  from: Address;
  destination: Address;
  /** The ERC-3009 nonce the merchant's wallet signed. */
  authorizationNonce: Hex | null;
  txHash: Hex | null;
  error: string | null;
  createdAt: IsoDate;
  paidAt: IsoDate | null;
  sample?: boolean;
};

/* ── Payment links ──────────────────────────────────────────────────────── */

export type LinkRecord = {
  id: string;
  merchantId: string;
  url: string;
  amountCents: number;
  description: string;
  modes: CheckoutMode[];
  usage: "single" | "reusable";
  expiresAt: IsoDate | null;
  /** `inactive`: the merchant turned it off; it opens no more checkouts. */
  status: "active" | "used" | "expired" | "inactive";
  paymentsCount: number;
  collectedCents: number;
  createdAt: IsoDate;
  sample?: boolean;
};

/* ── Webhooks ───────────────────────────────────────────────────────────── */

export type WebhookEndpointRecord = {
  id: string;
  merchantId: string;
  url: string;
  events: WebhookEventType[];
  /** The whole `whsec_…` string; every delivery is signed with it. */
  secret: string;
  secretHint: string;
  createdAt: IsoDate;
  disabledAt: IsoDate | null;
};

export type WebhookEventRecord = {
  /** `evt_…`. */
  id: string;
  merchantId: string;
  type: WebhookEventType;
  livemode: boolean;
  createdAt: IsoDate;
  /** The exact body every delivery of this event sends. */
  body: string;
  /** Dedupes chain-sourced events: `<txHash>:<logIndex>:<type>`, or `test:<id>`. */
  sourceKey: string;
  test: boolean;
  /** What fed it (absent on events written before it was recorded: the chain sync's, or a test). */
  source?: WebhookSource;
};

/**
 * Where an event came from: this server's own chain sync (a relayed
 * transaction's receipt, or its log reader), the Envio indexer's `Activity`
 * outbox, or the dashboard's "Send test event". Whichever chain path sees an
 * event first stores it; the other finds its id taken and sends nothing.
 */
export type WebhookSource = "chain" | "indexer" | "test";

export type DeliveryAttempt = {
  at: IsoDate;
  status: number | null;
  durationMs: number;
  error: string | null;
  responseBody: string | null;
};

export type WebhookDeliveryRecord = {
  /** `del_…`. */
  id: string;
  merchantId: string;
  endpointId: string;
  eventId: string;
  type: WebhookEventType;
  url: string;
  state: "pending" | "delivering" | "succeeded" | "failed";
  /** Attempts made so far. */
  attempts: DeliveryAttempt[];
  /** Epoch ms of the next attempt; null once it succeeded or gave up. */
  nextAttemptAtMs: number | null;
  /** Epoch ms until which a dispatcher owns this delivery. */
  lockedUntilMs: number;
  /** The headers and body of the last attempt. */
  request: { headers: Record<string, string>; body: string } | null;
  test: boolean;
  /** Its event's source, copied for the delivery log (absent on older deliveries). */
  source?: WebhookSource;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

/* ── Chain sync bookkeeping ─────────────────────────────────────────────── */

export type ChainCursorRecord = { id: string; block: number; updatedAt: IsoDate };

/**
 * The webhook dispatcher's place in the Envio indexer's `Activity` outbox
 * (POLARIS_INDEXER_URL), and how its last read went. One record, id
 * `activity`. `cursor` is the last row handled, as a decimal string (the
 * indexer's cursor is `blockNumber * 10^8 + logIndex * 100 + slot`, past
 * 2^53 on a long chain), or "" while no read has answered yet.
 */
export type IndexerOutboxRecord = {
  id: string;
  cursor: string;
  /** The indexer's progress block at the last successful read. */
  progressBlock: number | null;
  /** Last read attempt, and last one that answered. */
  polledAt: IsoDate | null;
  okAt: IsoDate | null;
  /** The last failed read, in words without the endpoint (cleared by the next success). */
  error: string | null;
  errorAt: IsoDate | null;
  /** Rows handled since the cursor started: sent as a new event, already sent by the chain sync, not ours, refused. */
  counts: { emitted: number; duplicates: number; skipped: number; rejected: number };
  /** The last row refused (its event failed polarispay-sdk's validateWebhookEvent, or the row was incomplete). */
  lastRejected: { cursor: string; kind: string; reason: string; at: IsoDate } | null;
  updatedAt: IsoDate;
};

/**
 * Dollars moving in or out of one address outside a merchant's own records:
 * money added (minted or bridged in), transfers to and from people, send
 * links made, claimed or taken back, and the transfers inside a payment or
 * an instalment (kept so a balance history adds up). One record per address
 * per AUSD Transfer log: `<txHash>:<logIndex>:<address>`.
 */
export type WalletMoveRecord = {
  id: string;
  /** The address whose book this is, lowercased. */
  address: string;
  kind: "added" | "received" | "sent" | "sent-link" | "claimed" | "link-returned" | "payment" | "refund" | "instalment" | "split-paid" | "split-received";
  direction: "in" | "out";
  amountUnits: string;
  counterparty: Address;
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
  /** A send link's key (sent-link, claimed, link-returned). */
  linkKey: Address | null;
  /** For a sent link: when it was claimed, or taken back. */
  settledAt: IsoDate | null;
  settledAs: "claimed" | "returned" | null;
  /** A share of a split (split-paid, split-received): the split's id and the share's index, from PolarisSplit.SharePaid. Absent on older records. */
  splitId?: Hex | null;
  shareIndex?: number | null;
  at: IsoDate;
};

/**
 * A split-the-bill link (PolarisSplit), as the chain sync saw it: what the
 * organiser opened, which share each friend paid and when, and whether it was
 * closed. Only what the chain shows: the split's words (what it's for, the
 * names) travel in the link and are never sent here. The chain's own
 * `splitOf`/`sharesOf` stay the authority; this record adds times and
 * transaction hashes. Keyed by the split id, lowercased.
 */
export type SplitRecord = {
  id: Hex;
  /** Lowercased. */
  organiser: string;
  totalUnits: string;
  /** One amount per share, base units. */
  amountsUnits: string[];
  /** Unix seconds. */
  expiresAt: number;
  memoHash: Hex;
  /** Who paid each share, when, in which transaction (null when the sync found it already paid); null while unpaid. */
  shares: Array<{ payer: Address; txHash: Hex | null; paidAt: IsoDate } | null>;
  paidCount: number;
  createdTxHash: Hex | null;
  createdBlock: number | null;
  createdAt: IsoDate;
  closedAt: IsoDate | null;
  closedTxHash: Hex | null;
  updatedAt: IsoDate;
};
/** A chain log we have handled: `<txHash>:<logIndex>`. Claimed before handling, released if handling fails. */
export type ProcessedLogRecord = { id: string; txHash: Hex; blockNumber: number; at: IsoDate };
/**
 * A chain log whose handler failed: `<txHash>:<logIndex>`. After a few
 * failures it is dead-lettered (`deadAt`), left claimed and skipped, so one
 * bad log can't hold the chain-sync cursor (and every event behind it) for
 * good. Kept for someone to look at and replay.
 */
export type FailedLogRecord = {
  id: string;
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
  event: string;
  attempts: number;
  lastError: string;
  firstFailedAt: IsoDate;
  lastFailedAt: IsoDate;
  deadAt: IsoDate | null;
};
export type CollectorRunRecord = {
  id: string;
  lastRunAt: IsoDate | null;
  lastRunBlock: number | null;
  lastTxHash: Hex | null;
  tasks: number;
  executed: number;
  skipped: number;
};

/* ── Credit: CRE underwriting requests and outcomes ─────────────────────── */

/** One signed request to underwrite a Polaris account, queued for the CRE underwriting workflow's HTTP trigger. */
export type UnderwritingRequestRecord = {
  /** `uwr_…`. */
  id: string;
  /** The Polaris account (lower-case), which signed the consent. */
  account: Address;
  /** The history wallet it links, or null for the account alone. */
  wallet: Address | null;
  /** Exactly what the trigger receives as `input` (the workflow verifies the signatures itself). */
  payload: {
    user: Address;
    consent: { issuedAt: number; nonce: string; signature: Hex };
    linked: { wallet: Address; issuedAt: number; nonce: string; signature: Hex } | null;
  };
  /** queued → sent (the trigger accepted it) → done (the workflow's callback came back), or failed. */
  state: "queued" | "sent" | "done" | "failed";
  attempts: number;
  error: string | null;
  createdAt: IsoDate;
  sentAt: IsoDate | null;
  doneAt: IsoDate | null;
};

/** What the CRE underwriting workflow decided for an account, from its signed callback. */
export type CreditDecisionRecord = {
  /** The account, lower-case. */
  id: string;
  /** `applied`: ScoreManager opened the line; `refused`: the receiver refused it; `thin`: no report, not enough evidence yet. */
  status: "applied" | "refused" | "thin";
  score: number | null;
  reason: string | null;
  linkedWallet: Address | null;
  txHash: Hex | null;
  /** The callback's own id, and when it arrived. */
  callbackId: string;
  at: IsoDate;
  /**
   * The report transaction behind it, as the chain sync saw it land
   * (UnderwritingApplied or UnderwritingRefused through the forwarder): the
   * provenance the app links to ("Verified by Chainlink CRE").
   */
  report?: { txHash: Hex; at: IsoDate; blockNumber: number } | null;
  /**
   * The buyer's reasons for this decision, explained by the underwriting
   * gateway from the facts the DON attested (each line with its points and
   * the provider behind it, e.g. Nansen). Undefined until tried; null when
   * there is no report to explain. `source`: the gateway, or the underwriting package in process.
   */
  explanation?: {
    score: number | null;
    limitUnits: string | null;
    reasons: Array<{ text: string; points: number | null; kind: string | null; provider: string | null }>;
    source: "gateway" | "package";
  } | null;
};

/* ── Chainlink CRE: what each workflow run did on chain ─────────────────── */

/** A task a collections report carried, as CollectionsReceiver reported it. */
export type CreTaskOutcome = {
  /** 1 collect an instalment, 2 charge a subscription, 3 liquidate. */
  action: number;
  /** The loan or subscription id. */
  id: string;
  executed: boolean;
  /** What TaskExecuted moved, base units; null for a skip. */
  amountUnits: string | null;
  /** Why it was skipped, in the chain sync's words (insufficient_funds, allowance_lost, stale, other). */
  reason: string | null;
};

/**
 * One CRE report that landed: a transaction through the forwarder to one of
 * our receivers, from its own events (CollectionsRun and its tasks,
 * UnderwritingApplied or Refused, CreditGuardUpdated or AttestationRefused).
 * The chain is the source: nothing here comes from a callback.
 */
export type CreRunRecord = {
  /** The transaction hash, lower-case: one report per transaction. */
  id: string;
  workflow: "collections" | "underwrite" | "guardian";
  txHash: Hex;
  blockNumber: number;
  at: IsoDate;
  /** Who delivered it: the forwarder's ReportProcessed and the transaction's sender, when the receipt could be read. */
  delivery: { forwarder: Address; transmitter: Address | null; workflowExecutionId: Hex | null; result: boolean } | null;
  collections?: {
    tasks: number;
    executed: number;
    skipped: number;
    items: CreTaskOutcome[];
    /**
     * A buyer's Reauthorized that this run collected after (the instant
     * retry on the EVM log trigger): the buyer, that transaction, and when.
     */
    afterReauthorization: { buyer: Address; txHash: Hex; at: IsoDate } | null;
  };
  underwrite?: { items: Array<{ user: Address; linkedWallet: Address | null; applied: boolean; score: number | null; reason: string | null }> };
  guardian?: {
    accepted: boolean;
    /** The feed round it wrote, when accepted. */
    round: number | null;
    creditPaused: boolean | null;
    reasons: number | null;
    /** AUSD/USD it cited, 8 decimals, and that Chainlink round. */
    price: string | null;
    priceRoundId: string | null;
    freeCashUnits: string | null;
    observedAt: IsoDate | null;
    /** Why it was refused (VerdictMismatch, AttestationOutOfOrder, …). */
    refusal: string | null;
  };
};

/** A buyer signed their approval again (PolarisCheckout.Reauthorized): the collections log trigger's event. */
export type ReauthorizationRecord = { id: string; buyer: Address; valueUnits: string; txHash: Hex; blockNumber: number; at: IsoDate };

/** A CRE callback we have handled, by its id: every DON node may deliver it. */
export type CreCallbackRecord = { id: string; type: string; receivedAt: IsoDate };

/* ── Receipts only the buyer can read ───────────────────────────────────── */

/**
 * A buyer's receipts inbox: the X25519 public key their Face ID derives
 * (@polaris/receipts), registered with the account's own signature over it.
 * Public by nature; the private half never leaves the buyer's device.
 */
export type ReceiptInboxRecord = {
  /** The account, lowercased. */
  id: string;
  /** `0x` + 64 hex: the 32-byte HPKE X25519 public key. */
  publicKey: Hex;
  /** The account's EIP-191 signature over `Polaris receipts key <publicKey>`. */
  signature: Hex;
  registeredAt: IsoDate;
  updatedAt: IsoDate;
};

/**
 * A receipt sealed to a buyer's inbox (RFC 9180 HPKE): what was bought,
 * readable only with the buyer's Face ID. The AAD binds it to `owner` and
 * `id`, so a row can't be served as another row or another buyer's. The
 * id is the payment record's (`0x…` Pay now, `plan:<loanId>`,
 * `sub:<subId>:<period>`), or `subscription:<subId>`, `instalment:<loanId>:<n>`.
 */
export type SealedReceiptRecord = {
  id: string;
  /** The buyer, lowercased. */
  owner: string;
  kind: "payment" | "plan" | "subscription" | "subscription-charge" | "instalment";
  /** HPKE's encapsulated key, base64url (32 bytes). */
  enc: string;
  /** The ciphertext, base64url. */
  ct: string;
  /** The transaction it belongs to: public on chain, and how the app pairs it with an activity row. */
  txHash: Hex | null;
  /** The public amount of that row, base units, to tell two receipts of one transaction apart. */
  amountUnits: string | null;
  merchantId: string | null;
  createdAt: IsoDate;
};

/* ── Collections ────────────────────────────────────────────────────────── */

const lower = (a: string | null | undefined) => (a ? a.toLowerCase() : null);

export const COLLECTIONS = {
  merchants: {
    name: "merchants",
    id: (d: MerchantRecord) => d.id,
    indexes: {
      publicId: (d: MerchantRecord) => d.publicId,
      wallet: (d: MerchantRecord) => lower(d.walletAddress),
      autoPayouts: (d: MerchantRecord) => d.autoPayouts.enabled,
      createdAt: (d: MerchantRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<MerchantRecord>,
  apiKeys: {
    name: "api_keys",
    id: (d: ApiKeyRecord) => d.id,
    indexes: {
      merchantId: (d: ApiKeyRecord) => d.merchantId,
      secretHash: (d: ApiKeyRecord) => d.secretHash,
      publishableKey: (d: ApiKeyRecord) => d.publishableKey,
      createdAt: (d: ApiKeyRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<ApiKeyRecord>,
  sessions: {
    name: "checkout_sessions",
    id: (d: CheckoutSessionRecord) => d.id,
    indexes: {
      merchantId: (d: CheckoutSessionRecord) => d.merchantId,
      orderKey: (d: CheckoutSessionRecord) => d.chain.orderKey.toLowerCase(),
      status: (d: CheckoutSessionRecord) => d.status,
      linkId: (d: CheckoutSessionRecord) => d.linkId,
      createdAt: (d: CheckoutSessionRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<CheckoutSessionRecord>,
  idempotency: {
    name: "idempotency_keys",
    id: (d: IdempotencyRecord) => d.id,
    indexes: { expiresAtMs: (d: IdempotencyRecord) => d.expiresAtMs, resourceId: (d: IdempotencyRecord) => d.resourceId ?? null },
  } satisfies CollectionSpec<IdempotencyRecord>,
  relays: {
    name: "relays",
    id: (d: RelayRecord) => d.id,
    indexes: {
      txHash: (d: RelayRecord) => lower(d.txHash),
      sessionId: (d: RelayRecord) => d.sessionId,
      state: (d: RelayRecord) => d.state,
      createdAt: (d: RelayRecord) => d.createdAt,
      checkedAt: (d: RelayRecord) => d.checkedAt ?? d.createdAt,
    },
  } satisfies CollectionSpec<RelayRecord>,
  payments: {
    name: "payments",
    id: (d: PaymentRecord) => d.id,
    indexes: {
      merchantId: (d: PaymentRecord) => d.merchantId,
      sessionId: (d: PaymentRecord) => d.sessionId,
      payer: (d: PaymentRecord) => d.payer.toLowerCase(),
      createdAt: (d: PaymentRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<PaymentRecord>,
  plans: {
    name: "plans",
    id: (d: PlanRecord) => d.id,
    indexes: {
      merchantId: (d: PlanRecord) => d.merchantId,
      state: (d: PlanRecord) => d.state,
      borrower: (d: PlanRecord) => d.borrower.toLowerCase(),
      createdAt: (d: PlanRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<PlanRecord>,
  subscriptions: {
    name: "subscriptions",
    id: (d: SubscriptionRecord) => d.id,
    indexes: {
      merchantId: (d: SubscriptionRecord) => d.merchantId,
      subscriber: (d: SubscriptionRecord) => d.subscriber.toLowerCase(),
      createdAt: (d: SubscriptionRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<SubscriptionRecord>,
  subscriptionPlans: {
    name: "subscription_plans",
    id: (d: SubscriptionPlanRecord) => d.id,
    indexes: { terms: (d: SubscriptionPlanRecord) => d.terms.toLowerCase(), merchantId: (d: SubscriptionPlanRecord) => d.merchantId },
  } satisfies CollectionSpec<SubscriptionPlanRecord>,
  payouts: {
    name: "payouts",
    id: (d: PayoutRecord) => d.id,
    indexes: {
      merchantId: (d: PayoutRecord) => d.merchantId,
      state: (d: PayoutRecord) => d.state,
      txHash: (d: PayoutRecord) => lower(d.txHash),
      createdAt: (d: PayoutRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<PayoutRecord>,
  links: {
    name: "payment_links",
    id: (d: LinkRecord) => d.id,
    indexes: { merchantId: (d: LinkRecord) => d.merchantId, createdAt: (d: LinkRecord) => d.createdAt, status: (d: LinkRecord) => d.status },
  } satisfies CollectionSpec<LinkRecord>,
  webhookEndpoints: {
    name: "webhook_endpoints",
    id: (d: WebhookEndpointRecord) => d.id,
    indexes: { merchantId: (d: WebhookEndpointRecord) => d.merchantId, createdAt: (d: WebhookEndpointRecord) => d.createdAt },
  } satisfies CollectionSpec<WebhookEndpointRecord>,
  webhookEvents: {
    name: "webhook_events",
    id: (d: WebhookEventRecord) => d.id,
    indexes: {
      merchantId: (d: WebhookEventRecord) => d.merchantId,
      sourceKey: (d: WebhookEventRecord) => d.sourceKey,
      createdAt: (d: WebhookEventRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<WebhookEventRecord>,
  webhookDeliveries: {
    name: "webhook_deliveries",
    id: (d: WebhookDeliveryRecord) => d.id,
    indexes: {
      merchantId: (d: WebhookDeliveryRecord) => d.merchantId,
      eventId: (d: WebhookDeliveryRecord) => d.eventId,
      state: (d: WebhookDeliveryRecord) => d.state,
      nextAttemptAtMs: (d: WebhookDeliveryRecord) => d.nextAttemptAtMs,
      createdAt: (d: WebhookDeliveryRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<WebhookDeliveryRecord>,
  cursors: {
    name: "chain_cursors",
    id: (d: ChainCursorRecord) => d.id,
    indexes: {},
  } satisfies CollectionSpec<ChainCursorRecord>,
  indexerOutbox: {
    name: "indexer_outbox",
    id: (d: IndexerOutboxRecord) => d.id,
    indexes: {},
  } satisfies CollectionSpec<IndexerOutboxRecord>,
  walletMoves: {
    name: "wallet_moves",
    id: (d: WalletMoveRecord) => d.id,
    indexes: {
      address: (d: WalletMoveRecord) => d.address,
      linkKey: (d: WalletMoveRecord) => lower(d.linkKey),
      at: (d: WalletMoveRecord) => d.at,
    },
  } satisfies CollectionSpec<WalletMoveRecord>,
  splits: {
    name: "splits",
    id: (d: SplitRecord) => d.id.toLowerCase(),
    indexes: {
      organiser: (d: SplitRecord) => d.organiser.toLowerCase(),
      createdAt: (d: SplitRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<SplitRecord>,
  processedLogs: {
    name: "processed_logs",
    id: (d: ProcessedLogRecord) => d.id,
    indexes: { blockNumber: (d: ProcessedLogRecord) => d.blockNumber },
  } satisfies CollectionSpec<ProcessedLogRecord>,
  collectorRuns: {
    name: "collector_runs",
    id: (d: CollectorRunRecord) => d.id,
    indexes: {},
  } satisfies CollectionSpec<CollectorRunRecord>,
  underwritingRequests: {
    name: "underwriting_requests",
    id: (d: UnderwritingRequestRecord) => d.id,
    indexes: {
      account: (d: UnderwritingRequestRecord) => d.account.toLowerCase(),
      state: (d: UnderwritingRequestRecord) => d.state,
      createdAt: (d: UnderwritingRequestRecord) => d.createdAt,
      sentAt: (d: UnderwritingRequestRecord) => d.sentAt,
    },
  } satisfies CollectionSpec<UnderwritingRequestRecord>,
  creditDecisions: {
    name: "credit_decisions",
    id: (d: CreditDecisionRecord) => d.id,
    indexes: { at: (d: CreditDecisionRecord) => d.at },
  } satisfies CollectionSpec<CreditDecisionRecord>,
  creCallbacks: {
    name: "cre_callbacks",
    id: (d: CreCallbackRecord) => d.id,
    indexes: { receivedAt: (d: CreCallbackRecord) => d.receivedAt },
  } satisfies CollectionSpec<CreCallbackRecord>,
  creRuns: {
    name: "cre_runs",
    id: (d: CreRunRecord) => d.id,
    indexes: { workflow: (d: CreRunRecord) => d.workflow, at: (d: CreRunRecord) => d.at },
  } satisfies CollectionSpec<CreRunRecord>,
  reauthorizations: {
    name: "reauthorizations",
    id: (d: ReauthorizationRecord) => d.id,
    indexes: { buyer: (d: ReauthorizationRecord) => d.buyer.toLowerCase(), at: (d: ReauthorizationRecord) => d.at },
  } satisfies CollectionSpec<ReauthorizationRecord>,
  failedLogs: {
    name: "failed_logs",
    id: (d: FailedLogRecord) => d.id,
    indexes: { blockNumber: (d: FailedLogRecord) => d.blockNumber, dead: (d: FailedLogRecord) => d.deadAt !== null },
  } satisfies CollectionSpec<FailedLogRecord>,
  receiptInboxes: {
    name: "receipt_inboxes",
    id: (d: ReceiptInboxRecord) => d.id,
    indexes: { registeredAt: (d: ReceiptInboxRecord) => d.registeredAt },
  } satisfies CollectionSpec<ReceiptInboxRecord>,
  receipts: {
    name: "sealed_receipts",
    id: (d: SealedReceiptRecord) => d.id,
    indexes: {
      owner: (d: SealedReceiptRecord) => d.owner.toLowerCase(),
      txHash: (d: SealedReceiptRecord) => lower(d.txHash),
      createdAt: (d: SealedReceiptRecord) => d.createdAt,
    },
  } satisfies CollectionSpec<SealedReceiptRecord>,
} as const;

/** Every collection, typed, over one store. */
export function collections(store: Store) {
  return {
    merchants: store.collection(COLLECTIONS.merchants),
    apiKeys: store.collection(COLLECTIONS.apiKeys),
    sessions: store.collection(COLLECTIONS.sessions),
    idempotency: store.collection(COLLECTIONS.idempotency),
    relays: store.collection(COLLECTIONS.relays),
    payments: store.collection(COLLECTIONS.payments),
    plans: store.collection(COLLECTIONS.plans),
    subscriptions: store.collection(COLLECTIONS.subscriptions),
    subscriptionPlans: store.collection(COLLECTIONS.subscriptionPlans),
    payouts: store.collection(COLLECTIONS.payouts),
    links: store.collection(COLLECTIONS.links),
    webhookEndpoints: store.collection(COLLECTIONS.webhookEndpoints),
    webhookEvents: store.collection(COLLECTIONS.webhookEvents),
    webhookDeliveries: store.collection(COLLECTIONS.webhookDeliveries),
    cursors: store.collection(COLLECTIONS.cursors),
    indexerOutbox: store.collection(COLLECTIONS.indexerOutbox),
    walletMoves: store.collection(COLLECTIONS.walletMoves),
    splits: store.collection(COLLECTIONS.splits),
    processedLogs: store.collection(COLLECTIONS.processedLogs),
    collectorRuns: store.collection(COLLECTIONS.collectorRuns),
    failedLogs: store.collection(COLLECTIONS.failedLogs),
    underwritingRequests: store.collection(COLLECTIONS.underwritingRequests),
    creditDecisions: store.collection(COLLECTIONS.creditDecisions),
    creCallbacks: store.collection(COLLECTIONS.creCallbacks),
    creRuns: store.collection(COLLECTIONS.creRuns),
    reauthorizations: store.collection(COLLECTIONS.reauthorizations),
    receiptInboxes: store.collection(COLLECTIONS.receiptInboxes),
    receipts: store.collection(COLLECTIONS.receipts),
  };
}

export type Collections = ReturnType<typeof collections>;

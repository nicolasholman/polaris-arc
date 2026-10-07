/**
 * The dashboard's domain, as the browser sees it.
 *
 * Money is integer US cents everywhere. AUSD carries 6 decimals on chain; the
 * indexer converts at its boundary, so nothing in the UI ever does float maths
 * on a balance. Times are ISO-8601 strings in UTC.
 */

export type Cents = number;
export type IsoDate = string;
export type Address = `0x${string}`;

export type Merchant = {
  /** The Privy user ID (`did:privy:...`). The only identity the server trusts. */
  id: string;
  businessName: string | null;
  /** The embedded payout wallet, read from Privy on the server. Never from a header. */
  walletAddress: Address | null;
  email: string | null;
  createdAt: IsoDate;
  /** What webhooks and the public API call this merchant: `mer_…`. */
  publicId?: string;
  /**
   * MerchantRegistry, on chain. `registered` merchants can take payments;
   * `active` ones can also offer Pay in 4 (activation sets their cap).
   */
  registration?: {
    state: "none" | "submitted" | "registered" | "active" | "failed";
    txHash: `0x${string}` | null;
    activationTxHash: `0x${string}` | null;
    error: string | null;
  };
};

/* ── Payment links ──────────────────────────────────────────────────────── */

/** How a buyer may pay: in full, in four instalments, or on a subscription. */
export type PayMode = "now" | "later" | "subscribe";
export type LinkUsage = "single" | "reusable";
/** inactive: the merchant turned it off; it takes no more payments. */
export type LinkStatus = "active" | "used" | "expired" | "inactive";

export type PaymentLink = {
  id: string;
  url: string;
  amountCents: Cents;
  description: string;
  modes: PayMode[];
  usage: LinkUsage;
  expiresAt: IsoDate | null;
  status: LinkStatus;
  paymentsCount: number;
  collectedCents: Cents;
  createdAt: IsoDate;
};

export type CreateLinkInput = {
  amountCents: Cents;
  description: string;
  modes: PayMode[];
  usage: LinkUsage;
  /** Hours from now, or null for a link that never expires. */
  expiresInHours: number | null;
};

/** Links are never deleted (payments point at them); they can be turned off. */
export type UpdateLinkInput = { active: false };

/* ── Payments ───────────────────────────────────────────────────────────── */

export type PaymentStatus = "succeeded" | "failed";

export type Payment = {
  id: string;
  orderId: string;
  description: string;
  /** The buyer's account address. Shown shortened; the buyer never sees it. */
  buyer: Address;
  mode: PayMode;
  status: PaymentStatus;
  amountCents: Cents;
  feeCents: Cents;
  netCents: Cents;
  /** What reached the merchant, in AUSD micro-units, so totals add up before they are truncated to cents. */
  netUnits?: string;
  linkId: string | null;
  /** Set once the indexer has seen the settling transaction. */
  txHash: `0x${string}` | null;
  createdAt: IsoDate;
};

/* ── Pay in 4 ───────────────────────────────────────────────────────────── */

/** collecting: on schedule. dunning: a collection failed and is being retried. */
export type PlanState = "collecting" | "dunning" | "repaid" | "written_off";
export type PlanFilter = "all" | "collecting" | "dunning" | "closed";

export type Plan = {
  id: string;
  orderId: string;
  description: string;
  buyer: Address;
  principalCents: Cents;
  /** What the buyer repays in total: principal plus pro-rated interest. */
  totalCents: Cents;
  outstandingCents: Cents;
  installmentCount: number;
  installmentsPaid: number;
  state: PlanState;
  /** Failed collection attempts on the current instalment. */
  attempts: number;
  nextDueAt: IsoDate | null;
  openedAt: IsoDate;
};

export type CollectorStatus = {
  state: "running" | "degraded" | "stopped";
  lastPassAt: IsoDate | null;
  /**
   * Where collections run: the `polaris-collections` CRE workflow, the only
   * runner. There is no fallback keeper: every collection action is
   * permissionless on chain, so anyone can run one (workflows/README.md).
   */
  runner: "cre";
};

/* ── Overview ───────────────────────────────────────────────────────────── */

export type Overview = {
  merchant: Merchant;
  /** The payout wallet's AUSD balance; null when the chain couldn't be read (never shown as $0). */
  balanceCents: Cents | null;
  today: {
    count: number;
    grossCents: Cents;
    payments: Payment[];
  };
  exposure: {
    /** Still owed across open plans: collecting plus at risk. */
    outstandingCents: Cents;
    collectingCents: Cents;
    collectingPlans: number;
    atRiskCents: Cents;
    atRiskPlans: number;
    collectedThisWeekCents: Cents;
    /** Instalments collected on time over those that came due, in %. Null until one has come due. */
    collectionRate: number | null;
  };
  collector: CollectorStatus;
  autoPayouts: AutoPayouts;
  /** The sponsor panels' live data (server/insights.ts); absent when it couldn't be read. */
  insights?: Insights;
};

/**
 * What the Overview's Envio and credit panels show for a live merchant.
 * `indexer.source`: "envio" (the Polaris Envio indexer), "envio-error" (it
 * is configured but didn't answer), or "chain-sync" (no indexer configured:
 * this server's own chain sync, labelled as such).
 */
export type Insights = {
  indexer:
    | { source: "envio"; events: import("./insights").IndexedEvent[]; progressBlock: number | null }
    | { source: "envio-error"; error: string }
    | { source: "chain-sync"; events: import("./insights").IndexedEvent[] };
  /** Null until a CRE underwriting decision with reasons exists for one of this merchant's Pay in 4 buyers. */
  underwriting: import("./insights").Underwriting | null;
};

/* ── Payouts ────────────────────────────────────────────────────────────── */

export type PayoutKind = "manual" | "automatic";
export type PayoutStatus = "paid" | "queued" | "failed";

export type Payout = {
  id: string;
  kind: PayoutKind;
  status: PayoutStatus;
  amountCents: Cents;
  destination: Address;
  /** True when the merchant's wallet signed the transfer authorisation. */
  signed: boolean;
  txHash: `0x${string}` | null;
  createdAt: IsoDate;
};

export type AutoPayouts = {
  enabled: boolean;
  payoutAddress: Address | null;
  /** The Privy policy that pins the signer to `payoutAddress`. Null until created. */
  policyId: string | null;
  /** Daily sweep time, in UTC hours. */
  hourUtc: number;
  nextRunAt: IsoDate | null;
};

export type PayoutsState = {
  /** The payout wallet's AUSD balance; null when the chain couldn't be read (never shown as $0). */
  balanceCents: Cents | null;
  /** The balance's change over the last 24 hours as the chain has it (truncated like the balance); null when nothing moved. Absent: work it out from the lists. */
  changeTodayCents?: Cents | null;
  walletAddress: Address | null;
  auto: AutoPayouts;
  history: Payout[];
};

export type WithdrawInput = {
  amountCents: Cents;
  destination: Address;
  /** Present when the payout wallet signed an ERC-3009 authorisation. */
  authorization?: {
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
    signature: `0x${string}`;
  };
};

export type AutoPayoutsInput = {
  enabled: boolean;
  payoutAddress: Address | null;
};

/* ── Developers ─────────────────────────────────────────────────────────── */

export type ApiKey = {
  id: string;
  name: string;
  /** Always shown in full: a publishable key is safe in a browser. */
  publishableKey: string;
  /** `sk_test_…` plus the last four characters. The secret itself is never stored. */
  secretHint: string;
  createdAt: IsoDate;
  lastUsedAt: IsoDate | null;
};

export type CreatedApiKey = {
  key: ApiKey;
  /** Returned exactly once, by the create call. */
  secret: string;
};

export type CreateApiKeyInput = { name: string };

export const WEBHOOK_EVENTS = [
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

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export type WebhookEndpoint = {
  id: string;
  url: string;
  events: WebhookEventType[];
  /** `whsec_…` plus the last four characters. */
  secretHint: string;
  createdAt: IsoDate;
};

export type CreatedWebhookEndpoint = {
  endpoint: WebhookEndpoint;
  /** The signing secret, returned exactly once. */
  secret: string;
};

export type CreateWebhookInput = {
  url: string;
  events: WebhookEventType[];
};

export type WebhookDelivery = {
  id: string;
  endpointId: string;
  url: string;
  event: WebhookEventType;
  eventId: string;
  /** HTTP status, or null when the attempt never got a response. */
  status: number | null;
  durationMs: number | null;
  attempt: number;
  test: boolean;
  /**
   * What fed its event: this server's chain sync, the Envio indexer's outbox, or
   * "Send test event". Absent on deliveries made before it was recorded.
   */
  source?: "chain" | "indexer" | "test";
  /** True only for a delivery that was signed and logged but never sent. Live and test deliveries are sent. */
  simulated: boolean;
  /** The exact headers and body of the last attempt (the body is the same on every attempt). */
  request: {
    headers: Record<string, string>;
    body: string;
  };
  createdAt: IsoDate;
  /** pending: queued or waiting for a retry; delivering: in flight; then succeeded or failed (retries exhausted). */
  state?: "pending" | "delivering" | "succeeded" | "failed";
  /** When the next retry runs, while `state` is pending. */
  nextAttemptAt?: IsoDate | null;
  /** Every attempt so far, oldest first. */
  attempts?: Array<{ at: IsoDate; status: number | null; durationMs: number; error: string | null; responseBody: string | null }>;
};

/**
 * Where live events come from: "chain-sync" (no indexer configured),
 * "indexer" (the Envio indexer's outbox, the chain sync as backup), or
 * "fallback" (the indexer is configured but didn't answer: the chain sync alone).
 */
export type WebhookFeed = { mode: "chain-sync" | "indexer" | "fallback"; checkedAt: IsoDate | null };

export type WebhooksState = {
  endpoints: WebhookEndpoint[];
  deliveries: WebhookDelivery[];
  feed?: WebhookFeed;
};

/* ── Onboarding on chain ────────────────────────────────────────────────── */

export type RegistrationState = NonNullable<Merchant["registration"]>["state"];

/** GET /api/merchant/registration: the state and, when needed, what to sign. */
export type RegistrationStep = {
  merchant: Merchant;
  /** EIP-712 `Registration` for the payout wallet, uint256 values as decimal strings. Null when nothing is left to sign. */
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: "Registration";
    message: Record<string, string> & { deadline: string };
  } | null;
};

/* ── What this server is connected to ───────────────────────────────────── */

/** GET /api/health, reduced to what the dashboard decides with. No secrets. */
export type Capabilities = {
  /** A deployment record and an RPC: payments, registration and balances are real. */
  chain: { id: number; name: string } | null;
  /** The relayer can submit (withdrawals, registration, buyer payments). */
  relayer: boolean;
  /** The Privy payout signer exists on the server (automatic payouts). */
  automaticPayouts: boolean;
  /** Registered merchants are activated for Pay in 4 automatically. */
  activation: boolean;
  /** Where payment links and sessions send buyers; null until it is configured. */
  checkoutOrigin: string | null;
  /** This server's public URL is set (it goes in the registry metadata), so merchants can register. */
  registrationUrl: boolean;
};

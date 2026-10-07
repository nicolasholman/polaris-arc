import type { Address, Hex } from "viem";
import type { Micros } from "../money";
import type { Eip712Domain } from "../sign";

/** Countries we draw a flag for. Anything else shows no badge. */
export type CountryCode = "AR" | "BR" | "DE" | "GB" | "IN" | "KE" | "MX" | "NG" | "PH" | "US";

export type Merchant = {
  id: string;
  name: string;
  /** Where the money lands. Never shown to the buyer. */
  address: Address;
  city: string;
  /** ISO 3166 alpha-2. */
  country: string;
  /** Short line under the name, e.g. "Design studio". */
  category: string;
};

export type Person = {
  id: string;
  name: string;
  country: CountryCode;
  /** How the sender recognises them: a phone number or handle. */
  handle: string;
  address?: Address;
};

/**
 * `memberSince` is when the account was made on this device or first seen on
 * chain, in ms; null when neither is known (no account yet): never invented.
 */
export type Profile = { name: string; memberSince: number | null };

export type Balance = {
  /** Spendable dollars, base units (6 decimals). */
  available: Micros;
  updatedAt: number;
};

/** Boost: dollars the account locked in CollateralVault, which ScoreManager adds to its Pay later limit. */
export type Boost = {
  /** `CollateralVault.lockedOf(owner)`, base units (6 decimals). */
  locked: Micros;
  /**
   * `CollateralVault.creditMultiplierBps()`: 15000 means $1 locked is worth
   * $1.50 of limit to an account with a line of its own. ScoreManager counts
   * it at face value for one without (`CreditLine.boostAtFaceValue`).
   */
  multiplierBps: number;
  /** The vault's address, the spender of the permit that adds to Boost. */
  vault: Address;
  /**
   * `CollateralVault.withdrawable(owner)`: what can be taken out now. All of
   * `locked`, or nothing while a Pay in 4 plan is open (the vault releases no
   * collateral while any debt is outstanding).
   */
  withdrawable: Micros;
  /**
   * The vault's EIP-712 domain (ERC-5267) when it takes signed withdrawals
   * (`withdrawWithSig`), which is what "Take out of Boost" signs under. Null
   * on a vault that predates them (Monad testnet's today): the app then says
   * taking out isn't available on this network yet.
   */
  takeOut: Eip712Domain | null;
  updatedAt: number;
};

export type CreditReason = {
  /** Plain language, e.g. "3 instalments paid on time". */
  label: string;
  /** Score points this fact adds (or removes). */
  points: number;
  /** Where the fact came from, when a provider supplied it: "Nansen", "Zerion". */
  source?: string | null;
};

export type CreditLine = {
  limit: Micros;
  available: Micros;
  used: Micros;
  /** 300–850, computed on chain from attested facts. */
  score: number;
  /** Annual rate in basis points: 1000 = 10%. */
  aprBps: number;
  nextPayment: { amount: Micros; dueAt: number; merchant: string; planId: string } | null;
  reasons: CreditReason[];
  /** Whether the buyer brought an outside history (§5.5). */
  historyLinked: boolean;
  /**
   * Whether ScoreManager counts this account's Boost at face value ($1 locked
   * adds $1 of limit) rather than at the vault's multiplier: true for an
   * account with no unsecured line (declined, or not underwritten while
   * underwriting is required). Null when the API couldn't read the chain, and
   * then the app claims no raise at all.
   */
  boostAtFaceValue: boolean | null;
  /** The opening line never goes past this; higher tiers come from repaying. */
  openingCap: Micros;
  /** When the line opened (the CRE decision); null when not known. */
  openedAt?: number | null;
  /** The score the line opened with; its history starts there. */
  openingScore?: number | null;
  /**
   * The report behind the line: the transaction the Chainlink CRE
   * underwriting workflow wrote, and when. Null until one exists.
   */
  verified: CreditProvenance | null;
};

/**
 * The underwriting report behind a credit line: its transaction, and which
 * forwarder delivered it (lib/provenance.ts turns that into words: "Verified
 * by Chainlink CRE" only for a DON-signed report).
 */
export type CreditProvenance = {
  by: "Chainlink CRE";
  /** The CRE workflow that wrote it: polaris-underwrite. */
  workflow: string;
  txHash: Hex;
  /** Null on a local chain, which has no explorer. */
  explorerUrl: string | null;
  /** When the report landed (its block time), ms. */
  at: number;
  /**
   * Who delivered it: `don` (Chainlink's KeystoneForwarder, DON-signed),
   * `simulation` (the CRE CLI's simulator through Chainlink's
   * MockKeystoneForwarder), `local` (a local chain), `unknown`. Missing from
   * an older API, which then never reads as verified.
   */
  delivery?: "don" | "simulation" | "local" | "unknown";
};

/**
 * The risk guard (the Chainlink CRE guardian's verdict, as PolarisCheckout
 * applies it to new Pay in 4 plans). A stale guard fails open: Pay in 4
 * keeps working and the screens say when it last checked.
 */
export type CreditGuardView = {
  state: "open" | "paused" | "stale" | "never" | "unconfigured" | "unavailable";
  paused: boolean;
  /** What the buyer reads while it is paused. */
  message: string | null;
  /** Seconds since it last checked, as of `readAt`; null before the first check. */
  ageSeconds: number | null;
  /** When the API read it, ms. */
  readAt: number;
};

export type Instalment = {
  index: number;
  amount: Micros;
  dueAt: number;
  paidAt: number | null;
};

export type Plan = {
  id: string;
  loanId: bigint;
  merchant: Merchant;
  description: string;
  principal: Micros;
  interest: Micros;
  interval: number;
  instalments: Instalment[];
  status: "active" | "completed";
  openedAt: number;
  /** Collections: why the current payment wasn't taken, and signing again for a lost approval. Absent in the offline demo. */
  collection?: PlanCollection;
};

export type PlanCollection = {
  /** The last failed collection of the current payment, and when it is tried again. */
  failure: { reason: "insufficient_funds" | "allowance_lost" | "other"; at: number; nextAttemptAt: number | null } | null;
  /** Polaris can no longer take this plan's payments: the buyer signs once more (PolarisCheckout.reauthorize). */
  needsSignature: boolean;
  /** They signed again, and the collection that followed (the CRE collections run), once it lands. */
  reauthorized: { at: number; txHash: Hex; collected: { at: number; txHash: Hex } | null } | null;
};

export type Subscription = {
  id: string;
  subId: bigint;
  merchant: Merchant;
  name: string;
  price: Micros;
  periodSeconds: number;
  nextChargeAt: number;
  startedAt: number;
  status: "active" | "cancelled";
};

export type ActivityKind =
  | "payment"
  | "instalment"
  | "plan-opened"
  | "subscription"
  | "sent-link"
  | "sent"
  | "received"
  | "claimed"
  | "refund"
  | "added"
  /** You paid your share of someone's split. */
  | "split-paid"
  /** A friend's share of your split arrived. */
  | "split-received";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  /** Who: a merchant or a person. */
  title: string;
  /** What: "Brand identity package", "Instalment 2 of 4", "Sent by link". */
  detail: string;
  direction: "in" | "out";
  amount: Micros;
  at: number;
  /** `category` is the merchant's ("Groceries", "Café"), for spending by category. */
  counterparty: { kind: "merchant" | "person" | "polaris"; name: string; country?: CountryCode; category?: string };
  /** Opens the explorer from "View receipt". */
  txHash: Hex;
  /** Only indexed chain events are "settled" (plan §5.6). */
  status: "settled" | "pending";
  /** The Pay in 4 plan it belongs to (plan-opened and instalment rows). */
  planId?: string;
  /** A send link's key, so its sender can take an unclaimed link back. */
  linkKey?: Address;
  /** A sent link: when it was claimed (or taken back). */
  settledAt?: number;
  /** A share of a split (split-paid, split-received): which split, and which share. */
  splitId?: Hex;
  shareIndex?: number;
  /** The receipt sealed to this account's Face ID that says what was bought (lib/receipts). */
  receiptId?: string;
};

export type PlanOffer = {
  installments: number;
  /** Seconds between instalments. */
  interval: number;
  aprBps: number;
  /** One amount per instalment, on the loan engine's ceil ladder. */
  amounts: Micros[];
  total: Micros;
  interest: Micros;
};

export type SubscriptionOffer = {
  planId: bigint;
  name: string;
  price: Micros;
  periodSeconds: number;
  /** Periods the permit covers up front ("a year of periods", plan §5.3). */
  periodsAuthorised: number;
};

export type PaymentLink = {
  id: string;
  merchant: Merchant;
  description: string;
  amount: Micros;
  /** The merchant's order reference; commits the buyer's signature (§5.2). */
  orderId: string;
  modes: {
    now: boolean;
    later: PlanOffer | null;
    subscription: SubscriptionOffer | null;
  };
  /** Where "Done" returns to, if the merchant sent the buyer here. */
  successUrl: string | null;
  status: "open" | "paid" | "expired";
  /**
   * The checkout session from Polaris for Business
   * (`/api/public/sessions/{id}`). Every link the app loads has one
   * (`remote.ts`); the type allows none for links built elsewhere (tests).
   */
  session?: CheckoutSessionInfo;
};

export type CheckoutSessionInfo = {
  /** The merchant page that opened the checkout, for `postMessage` (never "*"). */
  returnOrigin: string;
  cancelUrl: string | null;
  expiresAt: number;
  /** Why Pay in 4 isn't offered, in the buyer's words, when it isn't. */
  payLaterUnavailable: string | null;
  /** The risk guard as the checkout read it: paused (Pay in 4 shown as unavailable) or stale ("last checked 72 min ago"). */
  creditGuard: CreditGuardView | null;
  /** The way to pay the merchant's page chose (the session's first mode): the checkout opens on it. */
  preferredMode: "now" | "later" | "subscription" | null;
  /** How it was paid, once the chain says so. */
  payment: {
    mode: "now" | "later" | "subscribe";
    txHash: Hex;
    paymentId: Hex | null;
    planId: string | null;
    subscriptionId: string | null;
  } | null;
};

export type SendLinkStatus = {
  linkKey: Address;
  /** Known when the index has seen the link; the fragment carries it otherwise. */
  amount: Micros | null;
  senderName: string | null;
  status: "open" | "claimed" | "cancelled" | "expired";
  expiresAt: number | null;
  settledAt: number | null;
};

/** One share of a split. */
export type SplitShare = {
  index: number;
  amount: Micros;
  paid: boolean;
  /** Who paid it (compared with your own account; never shown). */
  payer: Address | null;
  paidAt: number | null;
  txHash: Hex | null;
  /** Null on a local chain, or when the sync hasn't seen the transaction. */
  explorerUrl: string | null;
};

/**
 * A split-the-bill link as the chain has it (PolarisSplit): the organiser,
 * each share's amount and who paid it. Its words (what it's for, the names)
 * are not here: they travel in the link (lib/split.ts), and `memoHash` is
 * what the link's words are checked against.
 */
export type SplitStatus = {
  id: Hex;
  organiser: Address;
  status: "open" | "settled" | "closed" | "expired";
  total: Micros;
  paid: Micros;
  shareCount: number;
  paidCount: number;
  expiresAt: number;
  memoHash: Hex;
  shares: SplitShare[];
  createdAt: number | null;
  closedAt: number | null;
};

/**
 * Every read the app makes, implemented by `live.ts` (the chain, and Polaris
 * for Business's records of chain events).
 */
export interface PolarisData {
  getProfile(owner: Address | null): Promise<Profile>;
  getBalance(owner: Address | null): Promise<Balance>;
  getCreditLine(owner: Address | null): Promise<CreditLine>;
  /** What the account has locked in Boost; null when the network has no CollateralVault (the app then shows no Boost). */
  getBoost(owner: Address | null): Promise<Boost | null>;
  /** The risk guard now; null when there is none to show. */
  getCreditGuard(): Promise<CreditGuardView | null>;
  getPlans(owner: Address | null): Promise<{ plans: Plan[]; subscriptions: Subscription[] }>;
  getActivity(owner: Address | null): Promise<ActivityItem[]>;
  getContacts(owner: Address | null): Promise<Person[]>;
  getPaymentLink(id: string): Promise<PaymentLink | null>;
  getSendLink(linkKey: Address): Promise<SendLinkStatus | null>;
  /** A split by its id, or null when there is none. `viewer` is who is looking. */
  getSplit(id: Hex, viewer: Address | null): Promise<SplitStatus | null>;
  /** The splits this account organised, newest first. */
  getSplits(owner: Address | null): Promise<SplitStatus[]>;
  /** Fires when anything above may have changed (new block, indexer event). */
  subscribe(listener: () => void): () => void;
}

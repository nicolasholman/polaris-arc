/**
 * Evidence in, `ScoreManager.Facts` out, deterministically.
 *
 * Every underwriting has one or two subjects (data.md §6): the buyer's Polaris
 * account, which is new and gasless, and optionally a wallet they already use,
 * proven by signature (plan §5.5). Nansen can see only the second.
 *
 * Derivation v1 (FACTS_VERSION = 1):
 *
 *   walletAgeDays      max over subjects of floor((observedAt - firstSeenAt) / 86400)
 *   txCount            sum of sentCount                                  (saturates at uint32)
 *   stableBalance      sum of stableBalance                              (saturates at uint64)
 *   defiTenureDays     max over subjects of floor((observedAt - defiSince) / 86400)
 *   priorLiquidations  sum of liquidations                               (saturates at uint16)
 *   exchangeFunded     the linked wallet's Nansen first funder names a known exchange
 *   relatedWallets     the linked wallet's cluster size, but 0 when it was exchange-funded
 *                      or the funder ties to INFRASTRUCTURE_OUTDEGREE (60) or more wallets:
 *                      that is a faucet or an exchange, not one person with many accounts
 *   observedAt         the caller's clock: DON time in CRE, never Date.now() inside the core
 *
 * Admission rules for the linked wallet, applied before the merge:
 *
 *   - A high-risk label on it or its funder (a mixer, an exploiter) excludes it.
 *   - If a risk check on it could not run (liquidations, cluster, labels, first
 *     funder), it is excluded from the preview, because crediting its history
 *     while a risk is unread could hide the risk.
 *
 * Missing data is never attested as zero (data.md §8). The derivation reports
 * `final: false` and lists what is missing; the CRE workflow must not send a
 * report that is not final.
 *
 * Evidence no configured provider could read (`not_configured`: the key is
 * not set on this deployment) is absent, never invented, and listed in
 * `absent`:
 *
 *   - a positive field (age, activity, dollars, savings and trading) earns no
 *     points and does not stop the report: asking again cannot change it, and
 *     leaving it out can only lower the score;
 *   - a risk field (liquidations, cluster, labels, first funder) is also
 *     `missing`, so a linked wallet whose risk could not be checked is left out
 *     and nothing is final. Underwriting runs once per account and binds the
 *     linked wallet to it (UnderwritingReceiver), so it waits for the key
 *     rather than spend that once without the history. `allowPartial` exists for operators who would
 * rather underwrite conservatively now than retry: missing positive facts then
 * count as zero and a linked wallet with a missing risk check is left out.
 * Underwriting runs once per account, so partial reports are off by default.
 */

import {
  DAY_SECONDS,
  FACTS_VERSION,
  INFRASTRUCTURE_OUTDEGREE,
  U16_MAX,
  U32_MAX,
  U64_MAX,
} from "./constants.ts";
import { exchangeIn } from "./labels.ts";
import type { EvidenceStatus, Facts, Funder, SubjectEvidence } from "./types.ts";

export type FactField = Exclude<keyof Facts, "observedAt">;

export interface Attribution {
  subject: "account" | "linked" | "none";
  source: string;
  status: EvidenceStatus;
  /** The value is a proven floor (Zerion probes), not an exact figure. */
  lowerBound: boolean;
}

export interface DeriveOptions {
  /** Attest conservatively instead of reporting `final: false`. Default false. */
  allowPartial?: boolean;
  /** Only 1 exists. Passing another version throws, so old reports stay reproducible. */
  version?: number;
}

export interface Derivation {
  version: number;
  facts: Facts;
  /** True when every fact the report depends on was read. Only final facts may be reported. */
  final: boolean;
  /** `<role>.<field>` for every evidence field that could not be read and may be read on a retry. */
  missing: string[];
  /**
   * `<role>.<field>` for every field no configured provider could read: absent,
   * earning no points. A risk field here is in `missing` too (see above).
   */
  absent: string[];
  linked: {
    address: string;
    used: boolean;
    excludedFor: "risk-label" | "missing-risk-check" | null;
    riskLabel: string | null;
  } | null;
  /** Where each fact came from, for the reasons and the audit trail. */
  attribution: Record<FactField, Attribution>;
  /** The exchange the linked wallet was first funded from, canonical name. */
  exchange: string | null;
  /** The funder ties to so many wallets it is infrastructure, so the cluster is ignored. */
  infrastructureFunder: boolean;
  /** The linked wallet's funder, for the reasons. */
  funder: Funder | null;
}

type EvidenceKey = Exclude<keyof SubjectEvidence, "address" | "role">;

/** Fields whose absence could hide a risk. */
const RISK_FIELDS: readonly EvidenceKey[] = ["liquidations", "relatedWallets", "riskLabel", "funder"];
/** Fields whose absence only costs the buyer points. */
const POSITIVE_FIELDS: readonly EvidenceKey[] = ["firstSeenAt", "sentCount", "stableBalance", "defiSince"];

function usable(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Read by no configured provider: absent, never a value. */
function isAbsent(s: SubjectEvidence, key: EvidenceKey): boolean {
  return s[key].status === "not_configured";
}

/** Evidence whose value is not a sane integer counts as missing, never as zero. */
function isMissing(s: SubjectEvidence, key: EvidenceKey): boolean {
  const ev = s[key];
  if (ev.status === "missing") return true;
  if (ev.status === "not_configured") return false;
  const v = ev.value;
  switch (key) {
    case "firstSeenAt":
    case "defiSince":
      return v !== null && !usable(v);
    case "sentCount":
    case "stableBalance":
    case "liquidations":
    case "relatedWallets":
      return !usable(v);
    case "riskLabel":
      return v !== null && typeof v !== "string";
    case "funder":
      return v !== null && (typeof v !== "object" || typeof (v as Funder).address !== "string");
  }
}

function daysSince(then: number | null, now: bigint): number {
  if (then === null) return 0;
  const t = BigInt(then);
  if (t >= now) return 0;
  const days = (now - t) / BigInt(DAY_SECONDS);
  return days > BigInt(U32_MAX) ? U32_MAX : Number(days);
}

const sat = (n: bigint, max: bigint): bigint => (n > max ? max : n);

function attribution(s: SubjectEvidence | null, key: EvidenceKey): Attribution {
  if (!s) return { subject: "none", source: "polaris.rule", status: "ok", lowerBound: false };
  const ev = s[key];
  return {
    subject: s.role,
    source: ev.source,
    status: ev.status,
    lowerBound: ev.source.endsWith(".probe"),
  };
}

export function deriveFacts(input: {
  account: SubjectEvidence;
  linked?: SubjectEvidence | null;
  observedAt: number | bigint;
  options?: DeriveOptions;
}): Derivation {
  const version = input.options?.version ?? FACTS_VERSION;
  if (version !== FACTS_VERSION) throw new RangeError(`unknown facts version ${version}`);
  const allowPartial = input.options?.allowPartial ?? false;
  const now = BigInt(input.observedAt);
  if (now < 0n || now > U64_MAX) throw new RangeError("observedAt does not fit uint64");

  const account = input.account;
  let linked = input.linked ?? null;
  if (linked && linked.address.toLowerCase() === account.address.toLowerCase()) linked = null;

  const missing: string[] = [];
  const absent: string[] = [];
  const collectMissing = (s: SubjectEvidence, keys: readonly EvidenceKey[]) =>
    keys.filter((k) => isMissing(s, k)).map((k) => `${s.role}.${k}`);
  const collectAbsent = (s: SubjectEvidence, keys: readonly EvidenceKey[]) =>
    keys.filter((k) => isAbsent(s, k)).map((k) => `${s.role}.${k}`);

  // An unread risk check is never waived by its provider being unconfigured.
  missing.push(...collectMissing(account, [...POSITIVE_FIELDS, ...RISK_FIELDS]), ...collectAbsent(account, RISK_FIELDS));
  absent.push(...collectAbsent(account, [...POSITIVE_FIELDS, ...RISK_FIELDS]));

  // Admission of the linked wallet.
  let linkedUsed = false;
  let excludedFor: "risk-label" | "missing-risk-check" | null = null;
  let riskLabel: string | null = null;
  if (linked) {
    const riskMissing = [...collectMissing(linked, RISK_FIELDS), ...collectAbsent(linked, RISK_FIELDS)];
    missing.push(...riskMissing, ...collectMissing(linked, POSITIVE_FIELDS));
    absent.push(...collectAbsent(linked, [...POSITIVE_FIELDS, ...RISK_FIELDS]));
    const label = linked.riskLabel.value;
    if (typeof label === "string" && !isMissing(linked, "riskLabel")) {
      riskLabel = label;
      excludedFor = "risk-label";
    } else if (riskMissing.length > 0) {
      excludedFor = "missing-risk-check";
    } else {
      linkedUsed = true;
    }
  }

  const subjects = linkedUsed && linked ? [account, linked] : [account];
  const val = (s: SubjectEvidence, key: EvidenceKey): number | null => {
    if (isMissing(s, key) || isAbsent(s, key)) return null;
    return s[key].value as number | null;
  };

  // Age and DeFi tenure: the oldest subject wins.
  let walletAgeDays = 0;
  let ageFrom: SubjectEvidence | null = null;
  let defiTenureDays = 0;
  let defiFrom: SubjectEvidence | null = null;
  let txCount = 0n;
  let stableBalance = 0n;
  let priorLiquidations = 0n;
  for (const s of subjects) {
    const age = daysSince(val(s, "firstSeenAt"), now);
    if (ageFrom === null || age > walletAgeDays) {
      ageFrom = s;
      walletAgeDays = age;
    }
    const defi = daysSince(val(s, "defiSince"), now);
    if (defi > defiTenureDays) {
      defiTenureDays = defi;
      defiFrom = s;
    }
    txCount += BigInt(val(s, "sentCount") ?? 0);
    stableBalance += BigInt(val(s, "stableBalance") ?? 0);
    priorLiquidations += BigInt(val(s, "liquidations") ?? 0);
  }

  // Funding: only the linked wallet has a native funder.
  const funder = linkedUsed && linked ? (linked.funder.value as Funder | null) : null;
  const exchange = funder ? exchangeIn(funder.name) : null;
  let relatedWallets = 0;
  let infrastructureFunder = false;
  if (linkedUsed && linked && !exchange) {
    const related = val(linked, "relatedWallets") ?? 0;
    if (related >= INFRASTRUCTURE_OUTDEGREE) infrastructureFunder = true;
    else relatedWallets = related;
  }

  const facts: Facts = {
    walletAgeDays,
    txCount: Number(sat(txCount, BigInt(U32_MAX))),
    stableBalance: sat(stableBalance, U64_MAX),
    defiTenureDays,
    priorLiquidations: Number(sat(priorLiquidations, BigInt(U16_MAX))),
    relatedWallets: Math.min(relatedWallets, U16_MAX),
    exchangeFunded: exchange !== null,
    observedAt: now,
  };

  const sumSource = (key: EvidenceKey): Attribution => {
    // A sum is attributed to the subject that contributed most; on a tie the
    // linked wallet, since that is the one a provider actually read.
    let best: SubjectEvidence | null = null;
    let bestValue = -1;
    for (const s of subjects) {
      const v = val(s, key) ?? 0;
      if (v >= bestValue) {
        best = s;
        bestValue = v;
      }
    }
    return attribution(best, key);
  };
  const linkedFor = (key: EvidenceKey): Attribution =>
    linkedUsed && linked ? attribution(linked, key) : attribution(null, key);

  return {
    version,
    facts,
    final: missing.length === 0 || allowPartial,
    missing,
    absent,
    linked: linked
      ? { address: linked.address, used: linkedUsed, excludedFor, riskLabel }
      : null,
    attribution: {
      walletAgeDays: attribution(ageFrom, "firstSeenAt"),
      txCount: sumSource("sentCount"),
      stableBalance: sumSource("stableBalance"),
      defiTenureDays: defiFrom ? attribution(defiFrom, "defiSince") : linkedFor("defiSince"),
      priorLiquidations: sumSource("liquidations"),
      relatedWallets: linkedFor("relatedWallets"),
      exchangeFunded: linkedFor("funder"),
    },
    exchange,
    infrastructureFunder,
    funder,
  };
}

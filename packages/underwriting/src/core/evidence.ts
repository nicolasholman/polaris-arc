/**
 * Small constructors for evidence, so the Node collectors and a CRE workflow
 * build `SubjectEvidence` the same way.
 */

import type { Address, Evidence, Funder, SubjectEvidence } from "./types.ts";

export const evidence = {
  ok: <T>(value: T, source: string): Evidence<T> => ({ value, status: "ok", source }),
  fallback: <T>(value: T, source: string, detail?: string): Evidence<T> =>
    detail ? { value, status: "fallback", source, detail } : { value, status: "fallback", source },
  empty: <T>(value: T, source: string, detail?: string): Evidence<T> =>
    detail ? { value, status: "empty", source, detail } : { value, status: "empty", source },
  missing: <T>(value: T, source: string, detail?: string): Evidence<T> =>
    detail ? { value, status: "missing", source, detail } : { value, status: "missing", source },
  /** No provider that reads this could be asked: none of them has a key here. */
  notConfigured: <T>(value: T, source: string, detail?: string): Evidence<T> =>
    detail ? { value, status: "not_configured", source, detail } : { value, status: "not_configured", source },
};

/**
 * The fields a Polaris account holds by construction. It is new, gasless and
 * on Monad testnet: nobody funded it with gas, it has no lending history, and
 * Nansen cannot see it. These are rules, not reads, so they are never missing.
 */
export function accountRules(): Pick<
  SubjectEvidence,
  "defiSince" | "liquidations" | "funder" | "relatedWallets" | "riskLabel"
> {
  return {
    defiSince: evidence.ok<number | null>(null, "polaris.rule"),
    liquidations: evidence.ok(0, "polaris.rule"),
    funder: evidence.ok<Funder | null>(null, "polaris.rule"),
    relatedWallets: evidence.ok(0, "polaris.rule"),
    riskLabel: evidence.ok<string | null>(null, "polaris.rule"),
  };
}

/** A subject with every field missing: what a collector returns when it cannot start. */
export function unknownSubject(address: Address, role: SubjectEvidence["role"], detail: string): SubjectEvidence {
  const m = <T>(v: T) => evidence.missing(v, "polaris.collector", detail);
  return {
    address,
    role,
    firstSeenAt: m<number | null>(null),
    sentCount: m(0),
    stableBalance: m(0),
    defiSince: m<number | null>(null),
    liquidations: m(0),
    funder: m<Funder | null>(null),
    relatedWallets: m(0),
    riskLabel: m<string | null>(null),
  };
}

/** Bigints to decimal strings, recursively, for JSON and for CRE consensus logs. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

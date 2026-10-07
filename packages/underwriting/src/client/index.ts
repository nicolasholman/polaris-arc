/**
 * `@polarispay/underwriting/client`: what the app's server calls to put the
 * underwriting in front of a buyer.
 *
 *   const uw = createUnderwritingClient({ baseUrl: env.UNDERWRITING_API_URL, token: env.UNDERWRITING_API_TOKEN });
 *   const a = await uw.underwrite({ account, linked: { wallet, proof }, purchase: 200_000_000n });
 *   a.decision.headline            "You can pay in 4 for up to $600.00."
 *   a.decision.reasons             each line with its points and `provider` ("nansen", ...)
 *   poweredBy(a.decision.reasons)  [{ provider: "nansen", name: "Nansen", reasons: ["age", "exchange", ...] }, ...]
 *   a.attest && a.report           the report the CRE workflow will attest, or a thin file / a preview
 *
 * It is a thin, typed wrapper over the HTTP API that `apps/gateway` serves
 * (and `createFetchHandler` mounts): `/health`, `/v1/underwrite`,
 * `/v1/explain` and `/v1/link-message`. Server side only: the token is the
 * gateway's bearer secret and must never reach a browser. It needs nothing
 * but `fetch`, so it runs in a Next.js route handler, on the edge or in Node.
 *
 * Amounts go out and come back as 6-decimal base units in decimal strings
 * (`Wire<T>` is `T` with every bigint as a string), exactly as the API sends
 * them, so nothing is lost between the gateway and the screen.
 */

import type { Derivation } from "../core/facts.ts";
import type { ScoreBreakdown } from "../core/score.ts";
import type { Address, CreditDecision, Facts, Hex, ProviderMode } from "../core/types.ts";
import type { Assessment, NotConfigured } from "../node/service.ts";

export { poweredBy, PROVIDER_NAMES, type ProviderCredit } from "../core/reasons.ts";

/** `T` as it travels in JSON: every bigint a decimal string. */
export type Wire<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

/** `POST /v1/underwrite`'s answer: the assessment without the bulky derivation. */
export type WireAssessment = Wire<Omit<Assessment, "derivation">> & {
  attribution: Wire<Derivation["attribution"]>;
  linked: Wire<Derivation["linked"]>;
};

/** One explanation of facts already on chain. */
export type WireExplanation = Wire<{
  user: Address | null;
  linkedWallet: Address | null;
  facts: Facts;
  breakdown: ScoreBreakdown;
  decision: CreditDecision;
}>;

export interface UnderwriteRequest {
  /** The buyer's Polaris account. */
  account: Address;
  /** A wallet they already use, with the signature from the Bring your history step. */
  linked?: { wallet: Address; proof?: { issuedAt: number; nonce: string; signature: Hex } | null } | null;
  /** A purchase to quote, in 6-decimal base units. */
  purchase?: bigint | null;
  /** What they owe on open plans (`activeDebtOf`), in base units. */
  activeDebt?: bigint;
  /** Report conservatively instead of asking to retry. */
  allowPartial?: boolean;
}

export interface ExplainOptions {
  purchase?: bigint | null;
  activeDebt?: bigint;
  hasLinked?: boolean;
}

export interface UnderwritingClientOptions {
  /** Where the gateway listens, e.g. `http://127.0.0.1:3510`. */
  baseUrl: string;
  /** `UNDERWRITING_API_TOKEN`. Required by any gateway not on loopback. */
  token?: string;
  /** Replace `fetch` (tests, or a mounted `createFetchHandler`). */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Per request. Default 20 s: an underwriting makes up to ~15 provider calls. */
  timeoutMs?: number;
}

/** A non-2xx answer, with the API's own code (`rate_limited`, `invalid_field`, ...). */
export class UnderwritingApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "UnderwritingApiError";
    this.status = status;
    this.code = code;
  }
}

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

function units(v: bigint | null | undefined, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "bigint" || v < 0n) throw new RangeError(`${name} must be a non-negative bigint in base units`);
  return v.toString();
}

export function createUnderwritingClient(opts: UnderwritingClientOptions) {
  let base: URL;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    throw new TypeError(`baseUrl is not a URL: ${JSON.stringify(opts.baseUrl)}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new TypeError("baseUrl must be http or https");
  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const token = opts.token && opts.token.trim() !== "" ? opts.token : undefined;

  // Keep a path prefix (a gateway behind a proxy at /underwriting/): join, never resolve.
  const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;

  async function call<T>(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
    const url = `${root}${path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await doFetch(url, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw new UnderwritingApiError(
        res.status,
        typeof e?.code === "string" ? e.code : "http_error",
        typeof e?.message === "string" ? e.message : `underwriting API answered HTTP ${res.status}`,
      );
    }
    if (parsed === null || typeof parsed !== "object") throw new UnderwritingApiError(res.status, "invalid_response", "underwriting API sent no JSON object");
    return parsed as T;
  }

  return {
    /** Each provider live or not_configured (with the variable it needs), and the facts and model versions. */
    health: () =>
      call<{
        ok: boolean;
        service: string;
        version: { facts: number; model: number };
        modes: Record<string, ProviderMode>;
        notConfigured: NotConfigured[];
      }>("/health", {
        method: "GET",
      }),

    /** Evidence to decision. Spends Nansen credits; the gateway rate-limits it. */
    underwrite(req: UnderwriteRequest): Promise<WireAssessment> {
      if (!isAddress(req.account)) throw new TypeError("account must be a 20-byte hex address");
      if (req.linked && !isAddress(req.linked.wallet)) throw new TypeError("linked.wallet must be a 20-byte hex address");
      return call<WireAssessment>("/v1/underwrite", {
        method: "POST",
        body: {
          account: req.account,
          linked: req.linked ?? undefined,
          purchaseBaseUnits: units(req.purchase, "purchase"),
          activeDebt: units(req.activeDebt, "activeDebt"),
          allowPartial: req.allowPartial === true ? true : undefined,
        },
      });
    },

    /** Explain facts already on chain, e.g. what the DON attested for this buyer. */
    explainFacts(facts: Facts, o: ExplainOptions = {}): Promise<WireExplanation> {
      return call<WireExplanation>("/v1/explain", {
        method: "POST",
        body: {
          facts: { ...facts, stableBalance: facts.stableBalance.toString(), observedAt: facts.observedAt.toString() },
          purchaseBaseUnits: units(o.purchase, "purchase"),
          activeDebt: units(o.activeDebt, "activeDebt"),
          hasLinked: o.hasLinked === true ? true : undefined,
        },
      });
    },

    /** Explain every underwriting in a report UnderwritingReceiver received. */
    async explainReport(report: Hex, o: ExplainOptions = {}): Promise<{ kind: number; items: WireExplanation[] }> {
      const out = await call<{ kind: number; items: WireExplanation[] }>("/v1/explain", {
        method: "POST",
        body: {
          report,
          purchaseBaseUnits: units(o.purchase, "purchase"),
          activeDebt: units(o.activeDebt, "activeDebt"),
          hasLinked: o.hasLinked === true ? true : undefined,
        },
      });
      return { kind: out.kind, items: out.items };
    },

    /** The exact text the buyer's existing wallet signs on the Bring your history step. */
    async linkMessage(q: { account: Address; wallet: Address; issuedAt: number; nonce: string }): Promise<string> {
      const qs = new URLSearchParams({ account: q.account, wallet: q.wallet, issuedAt: String(q.issuedAt), nonce: q.nonce });
      return (await call<{ message: string }>(`/v1/link-message?${qs.toString()}`, { method: "GET" })).message;
    },
  };
}

export type UnderwritingClient = ReturnType<typeof createUnderwritingClient>;

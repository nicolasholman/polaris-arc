/**
 * The underwriting service: clients from the environment, evidence from the
 * providers, and the pure core's decision.
 *
 *   const uw = Underwriter.fromEnv();
 *   const a = await uw.assess({ account, linked: { wallet, proof }, purchase: 200_000_000n });
 *   a.decision.payIn4.allowed, a.decision.reasons, a.final, a.report
 *
 * Modes: a provider with its key is live; one without is not configured and
 * is never called (NANSEN_API_KEY, ZERION_API_KEY, ETHERSCAN_API_KEY). Public
 * RPCs need no key and are always live. Nothing answers in a provider's
 * place: what only an unconfigured provider could read is absent, and every
 * assessment says which providers were not configured (`notConfigured`).
 */

import { verifyMessage } from "viem";
import { FACTS_VERSION, HISTORY_CHAINS, MODEL_VERSION, MONAD_TESTNET, PROVIDER_KEYS } from "../core/constants.ts";
import { unknownSubject } from "../core/evidence.ts";
import { linkMessage, linkProofStaleness } from "../core/link.ts";
import { notConfiguredProviders } from "../core/recipe.ts";
import type { Address, Hex, KeyedProvider, ProviderMode, SubjectEvidence } from "../core/types.ts";
import { underwrite, type UnderwriteOutcome } from "../core/underwrite.ts";
import { collectAccount, collectLinked, type CollectOptions, type Issue, type Providers } from "./collect.ts";
import { EtherscanClient } from "./etherscan.ts";
import { NansenClient } from "./nansen.ts";
import { RpcClient } from "./rpc.ts";
import { ZerionClient } from "./zerion.ts";

export interface AssessRequest {
  /** The buyer's Polaris account. */
  account: Address;
  /** A wallet they already use, with its signed proof (core/link.ts). */
  linked?: { wallet: Address; proof?: { issuedAt: number; nonce: string; signature: Hex } | null } | null;
  /** A purchase to quote, 6-decimal base units. */
  purchase?: bigint | null;
  /** What they owe on open plans, 6-decimal base units. */
  activeDebt?: bigint;
  /** Report conservatively instead of asking to retry. See core/facts.ts. */
  allowPartial?: boolean;
}

/** A provider this deployment has no key for, and the variable that would configure it. */
export interface NotConfigured {
  provider: KeyedProvider;
  env: string;
}

export interface Assessment extends UnderwriteOutcome {
  /** Unix seconds; also `facts.observedAt`. */
  assessedAt: number;
  /** Each provider on this deployment: live, or not configured. */
  providers: Record<"nansen" | "zerion" | "etherscan" | "rpc", ProviderMode>;
  /**
   * The providers this assessment needed and could not ask, because their key
   * is not set. What only they read is in `absent`; the UI can say, e.g.,
   * "Nansen not configured".
   */
  notConfigured: NotConfigured[];
  evidence: { account: SubjectEvidence; linked: SubjectEvidence | null };
  linkProof: { verified: boolean; reason: string | null } | null;
  /** Sources that did not answer, without secrets. */
  issues: Issue[];
  /** When the app should ask again, if the outcome is not final. */
  retryAfterSeconds: number | null;
  /** Nansen credits spent on this assessment, from `x-nansen-credits-used`. */
  credits: { nansen: number };
}

export interface UnderwriterOptions {
  providers: Providers;
  /** Unix seconds. */
  now?: () => number;
  collect?: Omit<CollectOptions, "now">;
  allowPartial?: boolean;
  /** Where Nansen credit headers are counted; set by `fromEnv`. */
  creditMeter?: CreditMeter;
}

/** Counts `x-nansen-credits-used` across requests. */
export class CreditMeter {
  total = 0;
  record(headers: Record<string, string>): void {
    const used = Number(headers["x-nansen-credits-used"] ?? "0");
    if (Number.isFinite(used) && used > 0) this.total += used;
  }
}

export class Underwriter {
  readonly providers: Providers;
  private readonly now: () => number;
  private readonly collect: Omit<CollectOptions, "now">;
  private readonly allowPartial: boolean;
  private readonly meter: CreditMeter | undefined;

  constructor(opts: UnderwriterOptions) {
    this.providers = opts.providers;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.collect = opts.collect ?? {};
    this.allowPartial = opts.allowPartial ?? false;
    this.meter = opts.creditMeter;
  }

  /**
   * Build every client from environment variables. See the README for the list.
   * `UNDERWRITING_MODE=fixture` no longer exists and is refused, so a
   * deployment that still sets it learns at start that nothing is synthesized.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env, overrides: Partial<UnderwriterOptions> = {}): Underwriter {
    const mode = env.UNDERWRITING_MODE?.trim();
    if (mode && mode !== "live") {
      throw new Error(
        `UNDERWRITING_MODE=${mode} is not supported: underwriting reads live providers only. ` +
          `Unset it; a provider without its key (${Object.values(PROVIDER_KEYS).join(", ")}) is reported as not configured.`,
      );
    }
    const meter = new CreditMeter();

    const nansen = new NansenClient({ apiKey: env.NANSEN_API_KEY, onResponse: (_s, res) => meter.record(res.headers) });
    const zerion = new ZerionClient({ apiKey: env.ZERION_API_KEY });
    const etherscan = new EtherscanClient({ apiKey: env.ETHERSCAN_API_KEY });
    const accountRpc = new RpcClient(env.MONAD_TESTNET_RPC_URL || MONAD_TESTNET.rpcUrl, MONAD_TESTNET.chainId);
    const historyRpcs = HISTORY_CHAINS.map((c) => new RpcClient(env[`RPC_URL_${c.chainId}`] || c.rpcUrl, c.chainId));

    return new Underwriter({
      providers: { nansen, zerion, etherscan, accountRpc, historyRpcs },
      allowPartial: env.UNDERWRITING_ALLOW_PARTIAL === "1",
      collect: { useNansenLabels: env.NANSEN_LABELS === "1" },
      creditMeter: meter,
      ...overrides,
    });
  }

  /** Each provider: live, or not configured (no key). Public RPCs are always live. */
  modes(): Record<"nansen" | "zerion" | "etherscan" | "rpc", ProviderMode> {
    const p = this.providers;
    return { nansen: p.nansen.mode, zerion: p.zerion.mode, etherscan: p.etherscan.mode, rpc: p.accountRpc.mode };
  }

  /** The keyed providers without a key on this deployment, with the variable each needs. */
  notConfigured(): NotConfigured[] {
    const p = this.providers;
    return [p.nansen, p.zerion, p.etherscan].filter((c) => c.mode === "not_configured").map((c) => ({ provider: c.provider as KeyedProvider, env: PROVIDER_KEYS[c.provider as KeyedProvider] }));
  }

  async assess(req: AssessRequest): Promise<Assessment> {
    const now = this.now();
    const opts: CollectOptions = { ...this.collect, now };
    const creditsBefore = this.meter?.total ?? 0;

    const wallet = req.linked?.wallet ?? null;
    const sameAsAccount = wallet !== null && wallet.toLowerCase() === req.account.toLowerCase();
    const linkedWallet = sameAsAccount ? null : wallet;

    const [account, linked, linkProof] = await Promise.all([
      collectAccount(req.account, this.providers, opts).catch((err: Error) => ({
        evidence: unknownSubject(req.account, "account", err.message),
        issues: [{ subject: "account" as const, source: "polaris.collector", code: "error", retryable: true, retryAfterMs: null, message: err.message }],
      })),
      linkedWallet
        ? collectLinked(linkedWallet, this.providers, opts).catch((err: Error) => ({
            evidence: unknownSubject(linkedWallet, "linked", err.message),
            issues: [{ subject: "linked" as const, source: "polaris.collector", code: "error", retryable: true, retryAfterMs: null, message: err.message }],
          }))
        : Promise.resolve(null),
      linkedWallet ? verifyLinkProof(req.account, linkedWallet, req.linked?.proof ?? null, now) : Promise.resolve(null),
    ]);

    const outcome = underwrite({
      user: req.account,
      observedAt: now,
      account: account.evidence,
      linked: linked?.evidence ?? null,
      linkVerified: linkProof?.verified ?? false,
      activeDebt: req.activeDebt,
      purchase: req.purchase ?? null,
      options: { allowPartial: req.allowPartial ?? this.allowPartial },
    });

    const issues = [...account.issues, ...(linked?.issues ?? [])];
    return {
      ...outcome,
      assessedAt: now,
      providers: this.modes(),
      notConfigured: notConfiguredProviders(issues).map((provider) => ({ provider, env: PROVIDER_KEYS[provider] })),
      evidence: { account: account.evidence, linked: linked?.evidence ?? null },
      linkProof,
      issues,
      retryAfterSeconds: outcome.final ? null : retryAfter(issues, outcome.missing, outcome.absent),
      credits: { nansen: (this.meter?.total ?? 0) - creditsBefore },
    };
  }
}

/** Check the EIP-191 signature a linked wallet made over `linkMessage`. */
export async function verifyLinkProof(
  account: Address,
  wallet: Address,
  proof: { issuedAt: number; nonce: string; signature: Hex } | null,
  now: number,
): Promise<{ verified: boolean; reason: string | null }> {
  if (!proof) return { verified: false, reason: "no ownership proof" };
  const stale = linkProofStaleness(proof.issuedAt, now);
  if (stale) return { verified: false, reason: `proof ${stale}` };
  try {
    const message = linkMessage({ account, wallet, issuedAt: proof.issuedAt, nonce: proof.nonce });
    const ok = await verifyMessage({ address: wallet, message, signature: proof.signature });
    return ok ? { verified: true, reason: null } : { verified: false, reason: "signature is not from this wallet" };
  } catch (err) {
    return { verified: false, reason: `unreadable proof: ${(err as Error).message.split("\n")[0]}` };
  }
}

function retryAfter(issues: Issue[], missing: string[], absent: string[]): number | null {
  if (missing.length === 1 && missing[0] === "linked.ownership") return null; // nothing to wait for; the buyer must sign
  // Only a key can finish it: asking again changes nothing until one is set.
  if (missing.some((m) => absent.includes(m))) return null;
  const waits = issues.map((i) => i.retryAfterMs ?? 0);
  const longest = Math.max(0, ...waits);
  return Math.max(30, Math.ceil(longest / 1000));
}

/** The facts' version and the model version this service speaks. */
export const SERVICE_VERSION = { facts: FACTS_VERSION, model: MODEL_VERSION } as const;

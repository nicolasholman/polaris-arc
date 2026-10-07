/**
 * Credit reviews: Polaris for Business queues a buyer's signed request
 * ("Raise your limit"), signs it to this keeper, and the keeper:
 *
 *   1. checks the account's consent (EIP-191, byte for byte the business's
 *      text) and the history wallet's link proof, each at most 15 minutes old;
 *   2. checks the chain first: an account already reviewed, an account that
 *      backs another as its history, a wallet already linked or reviewed;
 *   3. reads the evidence with @polarispay/underwriting (the account on Arc:
 *      USDC/EURC balances, transactions, age from Arc's explorer; the linked
 *      wallet on other chains through public RPCs, and Etherscan, Nansen or
 *      Zerion where their keys are set) and builds the facts;
 *   4. submits `UnderwritingReceiver.submitReport(abi.encode(uint8 2, ...))`:
 *      ScoreManager scores the facts on chain, never the keeper;
 *   5. tells the business what happened with a signed callback
 *      (credit.underwritten / credit.refused / credit.thin / credit.unavailable).
 */

import { scoreManagerAbi, underwritingReceiverAbi } from "@polarispay/contracts/abi";
import { type Assessment, Underwriter } from "@polarispay/underwriting";
import { type Address, decodeErrorResult, decodeEventLog, getAddress, type Hex, isAddress, type Log, recoverMessageAddress, zeroAddress } from "viem";

import { postCallback } from "./callback.ts";
import { type Clients, submitReport } from "./chain.ts";
import type { KeeperConfig } from "./config.ts";

export const EVIDENCE_MAX_AGE_SECONDS = 15 * 60;
const NONCE = /^[A-Za-z0-9_-]{8,64}$/;

function isoSeconds(issuedAt: number): string {
  return new Date(Math.floor(issuedAt) * 1000).toISOString().replace(".000Z", "Z");
}

/** The account's consent, as apps/business/src/server/credit/messages.ts writes it. */
export function underwriteConsentMessage(p: { account: Address; wallet: Address | null; chainId: number; issuedAt: number; nonce: string }): string {
  if (!NONCE.test(p.nonce)) throw new RangeError("nonce must be 8-64 url-safe characters");
  return [
    "Polaris: underwrite this account for Pay in 4 credit, once, from the evidence below.",
    "",
    `Account: ${p.account.toLowerCase()}`,
    `History wallet: ${p.wallet ? p.wallet.toLowerCase() : "none"}`,
    `Chain: ${p.chainId}`,
    `Issued: ${isoSeconds(p.issuedAt)}`,
    `Nonce: ${p.nonce}`,
  ].join("\n");
}

export function evidenceStaleness(issuedAt: number, nowSeconds: number): string | null {
  if (!Number.isFinite(issuedAt)) return "unreadable issue time";
  if (issuedAt > nowSeconds + 60) return "issued in the future";
  if (nowSeconds - issuedAt > EVIDENCE_MAX_AGE_SECONDS) return "older than 15 minutes";
  return null;
}

type Signed = { issuedAt: number; nonce: string; signature: Hex };
export type ReviewRequest = { user: Address; consent: Signed; linked: (Signed & { wallet: Address }) | null };

/** The body the business sends: `{ input: { user, consent, linked } }`. Throws on anything malformed. */
export function parseReviewRequest(raw: unknown): ReviewRequest {
  const input = (raw as { input?: unknown })?.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") throw new Error("body must be { input: {...} }");
  const signed = (v: unknown, name: string): Signed => {
    const s = v as Record<string, unknown> | null;
    if (!s || typeof s !== "object") throw new Error(`${name} is required`);
    if (typeof s.issuedAt !== "number" || !Number.isSafeInteger(s.issuedAt)) throw new Error(`${name}.issuedAt must be unix seconds`);
    if (typeof s.nonce !== "string" || !NONCE.test(s.nonce)) throw new Error(`${name}.nonce is malformed`);
    if (typeof s.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(s.signature)) throw new Error(`${name}.signature is malformed`);
    return { issuedAt: s.issuedAt, nonce: s.nonce, signature: s.signature as Hex };
  };
  if (typeof input.user !== "string" || !isAddress(input.user, { strict: false })) throw new Error("user must be an address");
  const user = getAddress(input.user);
  const consent = signed(input.consent, "consent");
  let linked: ReviewRequest["linked"] = null;
  if (input.linked) {
    const l = input.linked as Record<string, unknown>;
    if (typeof l.wallet !== "string" || !isAddress(l.wallet, { strict: false })) throw new Error("linked.wallet must be an address");
    linked = { ...signed(l, "linked"), wallet: getAddress(l.wallet) };
    if (linked.wallet === user) throw new Error("the history wallet must be another wallet");
  }
  return { user, consent, linked };
}

export type ReviewResult = {
  status: "applied" | "refused" | "thin" | "unavailable" | "incomplete" | "skipped" | "rejected";
  user: Address;
  linkedWallet: Address | null;
  score: number | null;
  reason: string | null;
  txHash: Hex | null;
};

const REFUSAL_ERRORS = [...scoreManagerAbi, ...underwritingReceiverAbi].filter((x) => x.type === "error");

export function decodeRefusal(reason: Hex): string {
  try {
    const d = decodeErrorResult({ abi: REFUSAL_ERRORS, data: reason });
    return d.args && d.args.length ? `${d.errorName}(${d.args.map(String).join(", ")})` : d.errorName;
  } catch {
    return `unknown(${reason.slice(0, 10)})`;
  }
}

type Profile = { initialized: boolean; underwritten: boolean; liquidations: number };

export class Reviewer {
  private readonly underwriter: Underwriter;
  private readonly c: Clients;
  private readonly config: KeeperConfig;

  constructor(c: Clients, config: KeeperConfig, underwriter?: Underwriter) {
    this.c = c;
    this.config = config;
    this.underwriter = underwriter ?? Underwriter.fromEnv(process.env);
  }

  private profileOf(who: Address): Promise<Profile> {
    return this.c.public.readContract({ address: this.config.contracts.scoreManager, abi: scoreManagerAbi, functionName: "profileOf", args: [who] }) as Promise<Profile>;
  }

  private linkedUserOf(who: Address): Promise<Address> {
    return this.c.public.readContract({ address: this.config.contracts.underwriting, abi: underwritingReceiverAbi, functionName: "linkedUserOf", args: [who] }) as Promise<Address>;
  }

  private async callback(type: string, r: ReviewRequest, extra: Record<string, unknown>) {
    await postCallback(this.config.callback, {
      id: `${type}:${r.user.toLowerCase()}:${r.consent.nonce}`,
      type,
      createdAt: Math.floor(Date.now() / 1000),
      chainId: this.config.chainId,
      user: r.user,
      linkedWallet: r.linked?.wallet ?? null,
      ...extra,
    });
  }

  async review(r: ReviewRequest): Promise<ReviewResult> {
    const wallet = r.linked?.wallet ?? null;
    const base: ReviewResult = { status: "rejected", user: r.user, linkedWallet: wallet, score: null, reason: null, txHash: null };
    const now = Math.floor(Date.now() / 1000);

    // 1. Signatures.
    const stale = evidenceStaleness(r.consent.issuedAt, now) ?? (r.linked ? evidenceStaleness(r.linked.issuedAt, now) : null);
    if (stale) return { ...base, reason: `consent ${stale}` };
    const consentText = underwriteConsentMessage({ account: r.user, wallet, chainId: this.config.chainId, issuedAt: r.consent.issuedAt, nonce: r.consent.nonce });
    const signer = await recoverMessageAddress({ message: consentText, signature: r.consent.signature }).catch(() => null);
    if (!signer || getAddress(signer) !== r.user) return { ...base, reason: "the consent wasn't signed by this account" };

    // 2. The chain's own refusals, before any provider is asked.
    const refuse = async (reason: string): Promise<ReviewResult> => {
      await this.callback("credit.refused", r, { score: null, reason, txHash: null });
      return { ...base, status: "refused", reason };
    };
    const profile = await this.profileOf(r.user);
    if (profile.underwritten) return { ...base, status: "skipped", reason: "already underwritten (AlreadyHasRecord)" };
    const backs = await this.linkedUserOf(r.user);
    if (backs !== zeroAddress) return refuse(`UserIsLinkedHistory: this account already backs ${backs} as its history wallet`);
    if (wallet) {
      const holder = await this.linkedUserOf(wallet);
      if (holder !== zeroAddress && holder !== r.user) return refuse(`WalletAlreadyLinked: this history wallet already backs ${holder}`);
      if ((await this.profileOf(wallet)).underwritten) return refuse("WalletAlreadyUnderwritten: this history wallet already holds a credit line of its own");
    }

    // 3. The evidence and the facts.
    let a: Assessment;
    try {
      a = await this.underwriter.assess({
        account: r.user,
        linked: r.linked ? { wallet: r.linked.wallet, proof: { issuedAt: r.linked.issuedAt, nonce: r.linked.nonce, signature: r.linked.signature } } : null,
        allowPartial: this.config.allowPartial,
      });
    } catch (e) {
      return { ...base, status: "incomplete", reason: `couldn't read the evidence: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (a.unavailable) {
      const reason = `not configured: ${a.notConfigured.map((n) => `${n.provider} (${n.env})`).join(", ") || "a provider"}`;
      await this.callback("credit.unavailable", r, { score: null, reason, txHash: null, notConfigured: a.notConfigured });
      return { ...base, status: "unavailable", reason };
    }
    if (!a.final) {
      const reason = `Some of the history couldn't be read just now (${a.missing.join(", ") || "a source"}). Try again in a few minutes.`;
      await this.callback("credit.refused", r, { score: null, reason, txHash: null });
      return { ...base, status: "incomplete", reason };
    }
    if (!a.attest || !a.report) {
      const reason = a.decision?.headline ?? "Not enough history yet to open a line.";
      await this.callback("credit.thin", r, { score: null, reason, txHash: null });
      return { ...base, status: "thin", reason };
    }

    // 4. The report: ScoreManager scores the facts on chain.
    if (!this.c.wallet) return { ...base, status: "incomplete", reason: "read-only keeper: no POLARIS_KEEPER_PRIVATE_KEY" };
    const { hash, receipt } = await submitReport(this.c, this.config.chainId, this.config.contracts.underwriting, a.report);
    for (const log of receipt.logs as Log[]) {
      if (log.address.toLowerCase() !== this.config.contracts.underwriting.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: underwritingReceiverAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (ev.eventName === "UnderwritingApplied") {
          const score = Number((ev.args as { score: number }).score);
          await this.callback("credit.underwritten", r, { score, reason: null, txHash: hash });
          return { ...base, status: "applied", score, txHash: hash };
        }
        if (ev.eventName === "UnderwritingRefused") {
          const reason = decodeRefusal((ev.args as { reason: Hex }).reason);
          await this.callback("credit.refused", r, { score: null, reason, txHash: hash });
          return { ...base, status: "refused", reason, txHash: hash };
        }
      } catch {
        // another event
      }
    }
    return { ...base, status: "refused", reason: "the report landed without a decision", txHash: hash };
  }
}

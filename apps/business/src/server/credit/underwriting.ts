import "server-only";

import { randomBytes } from "node:crypto";

import { newId, type UnderwritingRequestRecord } from "@polaris/db";
import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";

import { afterResponse } from "../background";
import { polarisLoanEngineAbi, scoreManagerAbi } from "../chain/abis";
import { publicClient, requireChain } from "../chain/client";
import { formatUnits } from "../chain/money";
import { deliveryOf, PROVENANCE_LABEL, reportForwarder } from "../cre/provenance";
import { getDb } from "../db";
import { explorerTxUrl, getConfig } from "../env";
import { HttpError } from "../http";
import { consume, LIMITS } from "../ratelimit";
import { address, signature } from "../relayer/parse";
import { explainUnderwriting } from "./explain";
import { evidenceStaleness, linkMessage, underwriteConsentMessage } from "./messages";

/**
 * Underwriting, fired by the product (plan §5.5).
 *
 * ScoreManager opens an account's unsecured Pay in 4 line only from a CRE
 * underwriting report (`requireUnderwriting`), and the workflow runs on an
 * HTTP trigger. This is what fires it:
 *
 * 1. The app asks for the texts to sign (`consentMessages`): the account's
 *    consent, and for "Bring your history" the history wallet's link proof.
 * 2. It posts the signatures (`requestUnderwriting`). We verify them here
 *    too, so strangers can't spend the trigger's rate limit or queue runs
 *    for someone else's account; the DON verifies them again, so a
 *    compromised API still can't underwrite anyone who didn't ask.
 * 3. Requests are queued, and `runUnderwritingQueue` (a worker loop, and the
 *    cron tick) sends them to the trigger one at a time, at most one per
 *    `CRE_TRIGGER_MIN_INTERVAL_MS` (CRE fires an HTTP trigger once per 30 s).
 * 4. The workflow writes the facts through the forwarder; ScoreManager
 *    scores them. Its signed callback (`/api/cre/callback`) records the
 *    outcome, and `creditStatus` shows it with the line read from the chain.
 *    When the review needs a data provider the workflow has no key for
 *    (`credit.unavailable`), nothing is decided: the request fails with
 *    `unavailableMessage`, naming the provider and the key it needs.
 *
 * Under simulation the trigger is `cre workflow simulate ./underwriting
 * --listen` (http://localhost:2000/trigger, body `{ "input": payload }`).
 * A deployed workflow is fired through Chainlink's gateway with a JWT signed
 * by one of its authorised keys, which needs deploy access; point
 * CRE_UNDERWRITING_TRIGGER_URL at a gateway proxy then.
 */

type Fetch = typeof fetch;
let fetchImpl: Fetch | null = null;

/** Tests: replace the network the trigger is called over. */
export function configureUnderwritingForTests(options: { fetch?: Fetch | null }): void {
  fetchImpl = options.fetch ?? null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The texts to sign right now, with a fresh nonce and issue time. */
export function consentMessages(account: Address, wallet: Address | null) {
  const chain = requireChain();
  if (wallet && getAddress(wallet) === getAddress(account)) {
    throw new HttpError(400, "invalid_request", "The history wallet must be another wallet than your Polaris account.", { param: "wallet" });
  }
  const issuedAt = nowSeconds();
  const nonce = randomBytes(12).toString("base64url");
  return {
    account: getAddress(account),
    wallet: wallet ? getAddress(wallet) : null,
    chainId: chain.id,
    issuedAt,
    nonce,
    expiresAt: issuedAt + 15 * 60,
    consent: underwriteConsentMessage({ account, wallet, chainId: chain.id, issuedAt, nonce }),
    link: wallet ? linkMessage({ account, wallet, issuedAt, nonce }) : null,
  };
}

function signedAt(body: Record<string, unknown>, key: string): { issuedAt: number; nonce: string; signature: Hex } {
  const raw = body[key];
  if (!raw || typeof raw !== "object") throw new HttpError(400, "invalid_request", `${key} is required.`, { param: key });
  const r = raw as Record<string, unknown>;
  const issuedAt = r.issuedAt;
  if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new HttpError(400, "invalid_request", `${key}.issuedAt must be unix seconds.`, { param: `${key}.issuedAt` });
  }
  if (typeof r.nonce !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(r.nonce)) {
    throw new HttpError(400, "invalid_request", `${key}.nonce must be 8-64 url-safe characters.`, { param: `${key}.nonce` });
  }
  return { issuedAt, nonce: r.nonce, signature: signature(body, `${key}.signature`) };
}

async function signerOf(message: string, sig: Hex): Promise<Address | null> {
  try {
    return getAddress(await recoverMessageAddress({ message, signature: sig }));
  } catch {
    return null;
  }
}

/**
 * Whether ScoreManager counts this account's Boost at face value: its
 * `_securedOnly` rule, `p.declined || (requireUnderwriting && !p.underwritten)`.
 * Such an account has no unsecured line, and `creditLimitOf` caps its boost at
 * what it locked (`min(creditBoostOf, lockedOf)`), so $1 locked adds $1 of
 * limit, not the vault's multiplier. Any other account gets the multiplier.
 */
export function boostAtFaceValue(profile: { declined: boolean; underwritten: boolean }, requireUnderwriting: boolean): boolean {
  return profile.declined || (requireUnderwriting && !profile.underwritten);
}

async function onChainProfile(account: Address) {
  const chain = requireChain();
  const client = publicClient();
  const [profile, requireUnderwriting, creditLimit, activeDebt] = await Promise.all([
    client.readContract({ address: chain.contracts.scoreManager, abi: scoreManagerAbi, functionName: "profileOf", args: [account] }) as Promise<{
      score: number;
      initialized: boolean;
      declined: boolean;
      underwritten: boolean;
    }>,
    client.readContract({ address: chain.contracts.scoreManager, abi: scoreManagerAbi, functionName: "requireUnderwriting" }) as Promise<boolean>,
    client.readContract({ address: chain.contracts.scoreManager, abi: scoreManagerAbi, functionName: "creditLimitOf", args: [account] }) as Promise<bigint>,
    (client.readContract({ address: chain.contracts.loanEngine, abi: polarisLoanEngineAbi, functionName: "activeDebtOf", args: [account] }) as Promise<bigint>).catch(() => 0n),
  ]);
  return { profile, requireUnderwriting, creditLimit, activeDebt };
}

function toPublic(r: UnderwritingRequestRecord) {
  return { id: r.id, state: r.state, wallet: r.wallet, error: r.error, createdAt: r.createdAt, sentAt: r.sentAt, doneAt: r.doneAt };
}

/** Queue an underwriting run for an account that signed its consent. */
export async function requestUnderwriting(body: Record<string, unknown>) {
  const config = getConfig();
  const chain = requireChain();
  if (!config.cre.underwritingTriggerUrl) {
    throw new HttpError(503, "underwriting_unavailable", "Credit reviews aren't running on this server yet. Pay now still works.");
  }
  const account = address(body, "account");
  const consent = signedAt(body, "consent");
  const linkedRaw = body.linked === undefined || body.linked === null ? null : signedAt(body, "linked");
  const wallet = linkedRaw ? address(body, "linked.wallet") : null;
  if (wallet && wallet === account) {
    throw new HttpError(400, "invalid_request", "The history wallet must be another wallet than your Polaris account.", { param: "linked.wallet" });
  }

  const now = nowSeconds();
  const stale = evidenceStaleness(consent.issuedAt, now) ?? (linkedRaw ? evidenceStaleness(linkedRaw.issuedAt, now) : null);
  if (stale) throw new HttpError(400, "signature_expired", `That confirmation is ${stale}. Sign again.`);

  const consentText = underwriteConsentMessage({ account, wallet, chainId: chain.id, issuedAt: consent.issuedAt, nonce: consent.nonce });
  if ((await signerOf(consentText, consent.signature)) !== account) {
    throw new HttpError(403, "invalid_signature", "That consent wasn't signed by this account.", { param: "consent.signature" });
  }
  if (linkedRaw && wallet) {
    const linkText = linkMessage({ account, wallet, issuedAt: linkedRaw.issuedAt, nonce: linkedRaw.nonce });
    if ((await signerOf(linkText, linkedRaw.signature)) !== wallet) {
      throw new HttpError(403, "invalid_signature", "The history wallet didn't sign that link.", { param: "linked.signature" });
    }
  }
  // Counted only once the account's own signature is verified, so no one can use up someone else's tries.
  consume(LIMITS.underwritePerAccount, account);
  consume(LIMITS.underwritePerAccountDaily, account);

  const { profile } = await onChainProfile(account);
  if (profile.underwritten) {
    throw new HttpError(409, "already_underwritten", "This account's credit line is already set. It grows as you pay on time.");
  }

  const db = getDb();
  const pending = await db.underwritingRequests.findOne({ account: account.toLowerCase(), state: { in: ["queued", "sent"] } }, { orderBy: "createdAt", direction: "desc" });
  if (pending && (pending.state === "queued" || Date.now() - Date.parse(pending.sentAt ?? pending.createdAt) < 10 * 60_000)) {
    return { request: toPublic(pending), position: await positionOf(pending), duplicate: true };
  }

  const record: UnderwritingRequestRecord = {
    id: newId("uwr", 20),
    account: account.toLowerCase() as Address,
    wallet,
    payload: {
      user: account,
      consent,
      linked: linkedRaw && wallet ? { wallet, ...linkedRaw } : null,
    },
    state: "queued",
    attempts: 0,
    error: null,
    createdAt: new Date().toISOString(),
    sentAt: null,
    doneAt: null,
  };
  await db.underwritingRequests.insert(record);
  afterResponse("underwriting: trigger", () => runUnderwritingQueue());
  return { request: toPublic(record), position: await positionOf(record), duplicate: false };
}

async function positionOf(r: UnderwritingRequestRecord): Promise<{ ahead: number; startsInSeconds: number }> {
  if (r.state !== "queued") return { ahead: 0, startsInSeconds: 0 };
  const ahead = await getDb().underwritingRequests.count({ state: "queued", createdAt: { lt: r.createdAt } });
  return { ahead, startsInSeconds: Math.ceil(((ahead + 1) * getConfig().cre.minTriggerIntervalMs) / 1000) };
}

export type UnderwritingQueueSummary = { sent: number; failed: number; waiting: number };

/**
 * Send the oldest queued request to the CRE trigger, if the last one went at
 * least `minTriggerIntervalMs` ago. One per call: the loop calls it every few
 * seconds. A consent that went stale while it waited is failed (the buyer
 * signs again); a trigger that refuses is retried twice.
 */
export async function runUnderwritingQueue(nowMs = Date.now()): Promise<UnderwritingQueueSummary> {
  const { cre } = getConfig();
  const db = getDb();
  const summary: UnderwritingQueueSummary = { sent: 0, failed: 0, waiting: await db.underwritingRequests.count({ state: "queued" }) };
  if (!cre.underwritingTriggerUrl || summary.waiting === 0) return summary;

  const last = await db.underwritingRequests.findOne({ sentAt: { gt: "" } }, { orderBy: "sentAt", direction: "desc" });
  if (last?.sentAt && nowMs - Date.parse(last.sentAt) < cre.minTriggerIntervalMs) return summary;

  const next = await db.underwritingRequests.findOne({ state: "queued" }, { orderBy: "createdAt" });
  if (!next) return summary;
  const at = new Date(nowMs).toISOString();
  const claimed = await db.underwritingRequests.update(next.id, (r) => (r.state === "queued" ? { ...r, state: "sent", sentAt: at, attempts: r.attempts + 1 } : r));
  if (!claimed || claimed.state !== "sent" || claimed.sentAt !== at) return summary;
  summary.waiting--;

  const stale = evidenceStaleness(claimed.payload.consent.issuedAt, Math.floor(nowMs / 1000));
  if (stale) {
    await db.underwritingRequests.update(claimed.id, (r) => ({ ...r, state: "failed", error: `The consent is ${stale}: sign again.` }));
    summary.failed++;
    return summary;
  }

  let error: string | null = null;
  try {
    const res = await (fetchImpl ?? fetch)(cre.underwritingTriggerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: claimed.payload }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) error = `The trigger answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
  } catch (e) {
    error = `The trigger couldn't be reached: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!error) {
    summary.sent++;
    return summary;
  }
  const failed = claimed.attempts >= 3;
  await db.underwritingRequests.update(claimed.id, (r) => ({ ...r, state: failed ? "failed" : "queued", error }));
  console.error(`[underwriting] ${claimed.id}: ${error}${failed ? " (giving up)" : " (will retry)"}`);
  if (failed) summary.failed++;
  else summary.waiting++;
  return summary;
}

/**
 * Explain a decision once, from the report the DON wrote (explain.ts), and
 * keep the answer on the decision. A failure is kept as "no explanation"
 * with a log line; the decision itself stands either way.
 */
export async function explainDecision(accountLower: string): Promise<void> {
  const db = getDb();
  const decision = await db.creditDecisions.get(accountLower);
  if (!decision || decision.explanation !== undefined || !decision.txHash) return;
  let explanation = null;
  try {
    explanation = await explainUnderwriting(getAddress(accountLower), decision.txHash, decision.linkedWallet !== null);
  } catch (error) {
    console.error(`[credit] couldn't explain the decision for ${accountLower}`, error);
  }
  await db.creditDecisions.update(accountLower, (d) => (d.callbackId === decision.callbackId ? { ...d, explanation } : d));
}

/**
 * The report behind a decision, as the app links it, and who stands behind
 * it (cre/provenance.ts): "Verified by Chainlink CRE" only for a report the
 * DON signed (Chainlink's KeystoneForwarder); a simulated run (the CLI through
 * Chainlink's MockKeystoneForwarder) or a local one says so instead.
 */
async function verifiedBy(decision: { txHash: Hex | null; at: string; report?: { txHash: Hex; at: string; blockNumber: number } | null }) {
  const txHash = decision.report?.txHash ?? decision.txHash;
  if (!txHash) return null;
  const chain = getConfig().chain;
  const forwarder = chain ? await reportForwarder(txHash, chain.contracts.underwriting) : null;
  const delivery = chain ? deliveryOf(forwarder, chain) : "unknown";
  return {
    by: "Chainlink CRE" as const,
    workflow: "polaris-underwrite" as const,
    txHash,
    /** The block time of the report when the chain sync has seen it, else when its callback arrived. */
    at: decision.report?.at ?? decision.at,
    blockNumber: decision.report?.blockNumber ?? null,
    explorerUrl: explorerTxUrl(txHash),
    /** Which forwarder delivered it, and what the app may call it: only `don` is "Verified by Chainlink CRE". */
    delivery,
    forwarder,
    label: PROVENANCE_LABEL[delivery],
  };
}

/** Where an account's credit stands: the line on chain, the latest request, and what the workflow decided. */
export async function creditStatus(account: Address) {
  const db = getDb();
  await explainDecision(account.toLowerCase());
  const [chainState, request, decision] = await Promise.all([
    onChainProfile(account).catch(() => null),
    db.underwritingRequests.findOne({ account: account.toLowerCase() }, { orderBy: "createdAt", direction: "desc" }),
    db.creditDecisions.get(account.toLowerCase()),
  ]);
  return {
    account,
    underwritingAvailable: Boolean(getConfig().cre.underwritingTriggerUrl),
    onChain: chainState
      ? {
          underwritten: chainState.profile.underwritten,
          declined: chainState.profile.declined,
          score: Number(chainState.profile.score),
          creditLimit: formatUnits(chainState.creditLimit),
          creditLimitUnits: chainState.creditLimit.toString(),
          /** What the account owes on open plans (PolarisLoanEngine.activeDebtOf). */
          activeDebtUnits: chainState.activeDebt.toString(),
          /**
           * Boost counts at face value ($1 locked adds $1 of limit) rather than
           * at the vault's multiplier: ScoreManager's secured-only rule, read
           * from `profileOf` and `requireUnderwriting` (see `boostAtFaceValue`).
           */
          boostAtFaceValue: boostAtFaceValue(chainState.profile, chainState.requireUnderwriting),
        }
      : null,
    request: request ? toPublic(request) : null,
    decision: decision
      ? {
          status: decision.status,
          score: decision.score,
          reason: decision.reason,
          linkedWallet: decision.linkedWallet,
          txHash: decision.txHash,
          at: decision.at,
          /** The reasons, line by line, each with the provider behind it ("nansen", "zerion", …). */
          explanation: decision.explanation ?? null,
          /**
           * Provenance: the report transaction the Chainlink CRE underwriting
           * workflow wrote (from the chain sync when it has seen it land, else
           * the callback's), when it landed, and where to see it.
           */
          verified: await verifiedBy(decision),
        }
      : null,
  };
}

/** The data providers a review can need, and the variable each is configured with (in workflows/.env, or the CRE secrets). */
const REVIEW_PROVIDERS: Record<string, { name: string; env: string }> = {
  nansen: { name: "Nansen", env: "NANSEN_API_KEY" },
  zerion: { name: "Zerion", env: "ZERION_API_KEY" },
  etherscan: { name: "Etherscan", env: "ETHERSCAN_API_KEY" },
};

const listOf = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * What "Raise your limit" says when a review can't run here: the providers it
 * needs that have no key on this deployment, by name and by key.
 *
 *   "This review needs Nansen, which isn't set up on this server yet (NANSEN_API_KEY). Pay now still works."
 */
export function unavailableMessage(providers: readonly string[]): string {
  const known = [...new Set(providers)].filter((p) => p in REVIEW_PROVIDERS).map((p) => REVIEW_PROVIDERS[p]!);
  if (known.length === 0) return "Credit reviews aren't fully set up on this server yet. Pay now still works.";
  const verb = known.length === 1 ? "isn't" : "aren't";
  return `This review needs ${listOf(known.map((k) => k.name))}, which ${verb} set up on this server yet (${listOf(known.map((k) => k.env))}). Pay now still works.`;
}

/**
 * The workflow could not review an account for want of provider keys: close
 * its open requests as failed with `unavailableMessage`. No decision is
 * recorded (none was made), so the buyer can ask again once the key is set.
 */
export async function recordUnavailable(input: { user: Address; providers: readonly string[] }): Promise<void> {
  const db = getDb();
  const at = new Date().toISOString();
  const error = unavailableMessage(input.providers);
  const open = await db.underwritingRequests.find({ account: input.user.toLowerCase(), state: { in: ["queued", "sent"] } });
  for (const r of open) {
    await db.underwritingRequests.update(r.id, (x) => ({ ...x, state: "failed", doneAt: at, error }));
  }
}

/** Record the workflow's decision for an account, and close its request. */
export async function recordDecision(input: {
  callbackId: string;
  status: "applied" | "refused" | "thin";
  user: Address;
  score: number | null;
  reason: string | null;
  linkedWallet: Address | null;
  txHash: Hex | null;
}): Promise<void> {
  const db = getDb();
  const at = new Date().toISOString();
  const id = input.user.toLowerCase();
  await db.creditDecisions.upsert({
    id,
    status: input.status,
    score: input.score,
    reason: input.reason,
    linkedWallet: input.linkedWallet,
    txHash: input.txHash,
    callbackId: input.callbackId,
    at,
  });
  const open = await db.underwritingRequests.find({ account: id, state: { in: ["queued", "sent"] } });
  for (const r of open) {
    await db.underwritingRequests.update(r.id, (x) => ({ ...x, state: "done", doneAt: at, error: input.status === "applied" ? null : input.reason }));
  }
  if (input.txHash) afterResponse("credit: explain", () => explainDecision(id));
}


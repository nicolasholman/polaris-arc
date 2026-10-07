/**
 * The underwriting recipe (docs/research/data.md §7.1), once, for every
 * driver.
 *
 * A recipe is a generator. It yields a batch of requests (built with the
 * provider modules' byte-stable builders, without secrets), receives one
 * reply per request, and eventually returns the subject's evidence. It never
 * does I/O itself, so:
 *
 *   - the Node service (and the Polaris keeper through it) drives it with
 *     `runAsync`, sending each batch concurrently through clients that add
 *     keys, retry and rate-limit;
 *   - a synchronous driver (`runSync`) replays it one request at a time, which
 *     is how the tests prove both drives read the same evidence.
 *
 *   const account = runSync(accountRecipe(user, { now, accountBalance }), send);
 *   const linked  = runSync(linkedRecipe(wallet, { now }), send);
 *   const out = underwrite({ user, observedAt: now, account: account.evidence, linked: linked.evidence, linkVerified });
 *
 * HTTP calls per run: the account takes 4 (plus 2 for balances unless
 * `accountBalance` is supplied from contract reads), all keyless; a linked
 * wallet takes 11 to 13 with the default three history chains and three
 * liquidation chains. Trim `historyRpcUrls` or `liquidationPools` to cut it.
 *
 * Which source answers each piece of evidence:
 *
 * | Evidence       | Polaris account (Arc)                               | Linked wallet (mainnet history)                           |
 * |----------------|-----------------------------------------------------|-----------------------------------------------------------|
 * | firstSeenAt    | Arc explorer: oldest of txlist and tokentx          | Nansen first-funder → Zerion probes                       |
 * | sentCount      | RPC nonce and explorer tokentx sent (larger wins)   | RPC nonces → Zerion txs (capped at 100)                   |
 * | stableBalance  | RPC balanceOf USDC + EURC                           | Zerion positions → Nansen current-balance                 |
 * | defiSince      | rule: none                                          | Zerion probes → Nansen transactions (dex, last year)      |
 * | liquidations   | rule: none                                          | Etherscan logs, allowlisted pools only                    |
 * | funder         | rule: none (Polaris pays the gas)                   | Nansen first-funder                                       |
 * | relatedWallets | rule: none                                          | Nansen related-wallets on the funder                      |
 * | riskLabel      | rule: none                                          | Nansen funder label (+ labels endpoint when enabled)      |
 *
 * The account's sources are Arc's public RPC and its Blockscout explorer, so
 * it needs no key. EURC counts toward the balance at one dollar a euro, which
 * understates it while the euro trades above the dollar.
 *
 * A keyed provider without its key is not configured: the driver answers each
 * of its requests with a `not_configured` reply (`notConfiguredReply`) without
 * sending anything, the next source in the row is asked, and a field no
 * configured source could read is `not_configured`, not `missing` (facts.ts
 * says what that costs). Nothing ever answers in a provider's place.
 */

import {
  ARC_TESTNET,
  DAY_SECONDS,
  HISTORY_CHAINS,
  LIQUIDATION_POOLS,
  NANSEN_RELATED_CHAINS,
  PROBE_EDGES_DAYS,
  PROVIDER_KEYS,
} from "./constants.ts";
import { accountRules, evidence } from "./evidence.ts";
import { exchangeIn, firstRisk, riskIn } from "./labels.ts";
import { ParseError, type RequestSpec } from "./providers/common.ts";
import { blockscoutRequests, parseFirstTransaction, parseTransfers } from "./providers/blockscout.ts";
import { etherscanRequests, parseLiquidationCount } from "./providers/etherscan.ts";
import {
  nansenRequests,
  parseCurrentBalanceStables,
  parseFirstFunder,
  parseLabels,
  classifyNansenFailure,
  parseOldestTransaction,
  parseRelatedWallets,
} from "./providers/nansen.ts";
import { parseRpcQuantity, rpcRequests } from "./providers/rpc.ts";
import { countedRows, isNotTrackable, parsePositionsStables, parseTransactions, zerionRequests } from "./providers/zerion.ts";
import type { Address, Evidence, Funder, KeyedProvider, SubjectEvidence } from "./types.ts";

/** What the driver hands back for each request. */
export type Reply =
  | { ok: true; status: number; body: unknown; headers?: Record<string, string> }
  | { ok: false; code: string; retryable: boolean; retryAfterMs: number | null; message: string };

/** The reply code for a request to a provider that has no key here. */
export const NOT_CONFIGURED = "not_configured";

/**
 * What a driver answers, without sending anything, for a request to a keyed
 * provider whose key is not set: not retryable, and it names the variable.
 */
export function notConfiguredReply(spec: RequestSpec): Extract<Reply, { ok: false }> {
  const env = spec.provider === "rpc" || spec.provider === "blockscout" ? null : PROVIDER_KEYS[spec.provider];
  return {
    ok: false,
    code: NOT_CONFIGURED,
    retryable: false,
    retryAfterMs: null,
    message: `${spec.provider}.${spec.endpoint}: ${spec.provider} is not configured${env ? ` (${env} is not set)` : ""}`,
  };
}

/** The keyed providers behind `not_configured` issues, each once, in order. */
export function notConfiguredProviders(issues: ReadonlyArray<Pick<Issue, "source" | "code">>): KeyedProvider[] {
  const out: KeyedProvider[] = [];
  for (const i of issues) {
    if (i.code !== NOT_CONFIGURED) continue;
    const p = i.source.split(".")[0];
    if ((p === "nansen" || p === "zerion" || p === "etherscan") && !out.includes(p)) out.push(p);
  }
  return out;
}

/** A source that did not answer. Non-secret; safe to return to the caller. */
export interface Issue {
  subject: "account" | "linked";
  source: string;
  code: string;
  retryable: boolean;
  retryAfterMs: number | null;
  message: string;
}

export interface Collected {
  evidence: SubjectEvidence;
  issues: Issue[];
}

export type Recipe<T> = Generator<RequestSpec[], T, Reply[]>;

export interface RecipeOptions {
  /** Unix seconds: the same "now" the Facts are stamped with. */
  now: number;
  /** The account chain's RPC (default Arc testnet), for the account's balances and nonce. */
  accountRpcUrl?: string;
  /**
   * The account chain's Blockscout API (default Arc testnet's), for the
   * account's age and transfers. `null`: there is no explorer for this chain
   * (a local chain), so what only it reads is not configured.
   */
  accountExplorerApiUrl?: string | null;
  /** RPCs whose nonces count as a linked wallet's sent transactions. */
  historyRpcUrls?: readonly string[];
  /** The account chain's dollar tokens, 6 decimals each (default Arc testnet USDC and EURC). */
  accountTokens?: readonly string[];
  /** The account's dollars, already read another way (contract reads). Skips the balance calls. */
  accountBalance?: number;
  probeEdgesDays?: readonly number[];
  liquidationPools?: Readonly<Record<number, readonly string[]>>;
  /** Spend 100 Nansen credits on the labels endpoint for the risk screen. */
  useNansenLabels?: boolean;
}

// ------------------------------------------------------------------ drivers

/** Drive a recipe with a synchronous sender, one request at a time. */
export function runSync<T>(recipe: Recipe<T>, send: (spec: RequestSpec) => Reply): T {
  let step = recipe.next([]);
  while (!step.done) step = recipe.next(step.value.map(send));
  return step.value;
}

/** Drive a recipe with an asynchronous sender, each batch concurrently (Node, the keeper). */
export async function runAsync<T>(recipe: Recipe<T>, send: (spec: RequestSpec) => Promise<Reply>): Promise<T> {
  let step = recipe.next([]);
  while (!step.done) step = recipe.next(await Promise.all(step.value.map(send)));
  return step.value;
}

/** Run recipes in lockstep: every round sends each unfinished recipe's next batch together. */
export function* all<T extends readonly unknown[]>(recipes: { [K in keyof T]: Recipe<T[K]> }): Recipe<T> {
  const list = recipes as unknown as Array<Recipe<unknown>>;
  const out = new Array<unknown>(list.length);
  let live: Array<{ i: number; batch: RequestSpec[] }> = [];
  list.forEach((r, i) => {
    const s = r.next([]);
    if (s.done) out[i] = s.value;
    else live.push({ i, batch: s.value });
  });
  while (live.length > 0) {
    const replies: Reply[] = yield live.flatMap((l) => l.batch);
    const next: typeof live = [];
    let offset = 0;
    for (const l of live) {
      const mine = replies.slice(offset, offset + l.batch.length);
      offset += l.batch.length;
      const s = list[l.i]!.next(mine);
      if (s.done) out[l.i] = s.value;
      else next.push({ i: l.i, batch: s.value });
    }
    live = next;
  }
  return out as unknown as T;
}

// ------------------------------------------------------------------ reading replies

type Got<T> = { ok: true; value: T } | { ok: false; issue: Omit<Issue, "subject"> };

const sourceOf = (spec: RequestSpec) => `${spec.provider}.${spec.endpoint}`;

function fail(spec: RequestSpec, code: string, message: string, retryable = false, retryAfterMs: number | null = null): Got<never> {
  return { ok: false, issue: { source: sourceOf(spec), code, retryable, retryAfterMs, message: `${sourceOf(spec)}: ${message}` } };
}

function parsed<T>(spec: RequestSpec, body: unknown, parse: (b: unknown) => T): Got<T> {
  try {
    return { ok: true, value: parse(body) };
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    // Etherscan reports rate limits as status "0" inside a 200.
    const limited = /rate limit/i.test(err.message);
    return fail(spec, limited ? "rate_limited" : "parse_error", err.message, limited);
  }
}

function statusCode(status: number): string {
  if (status === 401 || status === 402) return "unauthorized";
  if (status === 403) return "insufficient_credits";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_request";
  return "http_error";
}

function read<T>(spec: RequestSpec, reply: Reply | undefined, parse: (b: unknown) => T): Got<T> {
  if (!reply) return fail(spec, "no_reply", "the driver sent no reply", true);
  if (!reply.ok) return { ok: false, issue: { source: sourceOf(spec), code: reply.code, retryable: reply.retryable, retryAfterMs: reply.retryAfterMs, message: reply.message } };
  if (reply.status !== 200) {
    if (spec.provider === "nansen") {
      const n = classifyNansenFailure(reply.status, reply.body);
      return fail(spec, n.code, n.detail);
    }
    return fail(spec, statusCode(reply.status), `HTTP ${reply.status}`);
  }
  return parsed(spec, reply.body, parse);
}

/** Zerion's "not trackable" 400 is a known empty, not a failure. */
function readZerion<T>(spec: RequestSpec, reply: Reply | undefined, parse: (b: unknown) => T): Got<T | "not-trackable"> {
  if (reply?.ok && isNotTrackable(reply.status, reply.body)) return { ok: true, value: "not-trackable" };
  return read(spec, reply, parse);
}

function* ask<T>(spec: RequestSpec, parse: (b: unknown) => T): Recipe<Got<T>> {
  const [reply] = yield [spec];
  return read(spec, reply, parse);
}

function* askZerion<T>(spec: RequestSpec, parse: (b: unknown) => T): Recipe<Got<T | "not-trackable">> {
  const [reply] = yield [spec];
  return readZerion(spec, reply, parse);
}

function* nothing<T>(value: T): Recipe<T> {
  return value;
}

type Failed = { ok: false; issue: Omit<Issue, "subject"> };

/**
 * Evidence no source could read: `not_configured` when every source tried was
 * a provider with no key (asking again cannot help), else `missing`.
 */
function lost<T>(value: T, source: string, detail: string, failures: ReadonlyArray<Failed | null | undefined>): Evidence<T> {
  const tried = failures.filter((f): f is Failed => !!f);
  if (tried.length > 0 && tried.every((f) => f.issue.code === NOT_CONFIGURED)) {
    const names = [...new Set(tried.map((f) => f.issue.source.split(".")[0]))];
    return evidence.notConfigured(value, source, `${names.join(" and ")} not configured`);
  }
  return evidence.missing(value, source, detail);
}

const failure = <T>(g: Got<T>): Failed | null => (g.ok ? null : g);

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const safe = (n: bigint) => Number(n > MAX_SAFE ? MAX_SAFE : n);

/**
 * Binary search over probe edges: the largest N such that some activity
 * (matching `ops`) is at least N days old. `since` is then now − N days, a
 * proven floor. At most ceil(log2(edges + 1)) requests, whatever the history.
 */
function* probeSince(
  address: string,
  now: number,
  edges: readonly number[],
  q: { chainIds?: string[]; operationTypes?: ("trade" | "deposit" | "withdraw")[] },
): Recipe<Got<{ since: number | null; notTrackable: boolean }>> {
  let lo = 0;
  let hi = edges.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const spec = zerionRequests.transactions(address, { ...q, trash: "only_non_trash", maxMinedAt: now - edges[mid]! * DAY_SECONDS, pageSize: 1 });
    const got = yield* askZerion(spec, parseTransactions);
    if (!got.ok) return { ok: false, issue: { ...got.issue, source: "zerion.probe" } };
    if (got.value === "not-trackable") return { ok: true, value: { since: null, notTrackable: true } };
    if (countedRows(got.value).length > 0) {
      best = edges[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return { ok: true, value: { since: best === null ? null : now - best * DAY_SECONDS, notTrackable: false } };
}

// ------------------------------------------------------------------ the Polaris account

/** How many recent transfers the account's sent count reads: one page. */
const TRANSFER_PAGE = 100;

export function* accountRecipe(address: Address, o: RecipeOptions): Recipe<Collected> {
  const issues: Issue[] = [];
  const note = (g: { issue: Omit<Issue, "subject"> }) => issues.push({ subject: "account", ...g.issue });
  const tokens = o.accountTokens ?? [ARC_TESTNET.usdc, ARC_TESTNET.eurc];
  const rpcUrl = o.accountRpcUrl ?? ARC_TESTNET.rpcUrl;
  const explorer = o.accountExplorerApiUrl === undefined ? ARC_TESTNET.explorerApiUrl : o.accountExplorerApiUrl;

  function* balance(): Recipe<Evidence<number>> {
    if (o.accountBalance !== undefined) return evidence.ok(o.accountBalance, "rpc.balance");
    const specs = tokens.map((t) => rpcRequests.balanceOf(rpcUrl, t, address));
    const replies = specs.length ? yield specs : [];
    let total = 0n;
    for (const [i, spec] of specs.entries()) {
      const g = read(spec, replies[i], parseRpcQuantity);
      if (!g.ok) {
        note(g);
        return evidence.missing(0, "rpc.balance", "balance unavailable");
      }
      total += g.value;
    }
    return evidence.ok(safe(total), "rpc.balance");
  }

  function* activity(): Recipe<Pick<SubjectEvidence, "firstSeenAt" | "sentCount">> {
    const nonceSpec = rpcRequests.transactionCount(rpcUrl, address);
    if (explorer === null) {
      // No explorer for this chain: the nonce is all there is, and the age is not configured.
      const [r] = yield [nonceSpec];
      const n = read(nonceSpec, r, parseRpcQuantity);
      if (!n.ok) note(n);
      return {
        firstSeenAt: evidence.notConfigured<number | null>(null, "blockscout.txlist", "explorer not configured"),
        sentCount: n.ok ? evidence.fallback(safe(n.value), "rpc.nonce", "explorer not configured") : evidence.missing(0, "rpc.nonce", "nonce unavailable; explorer not configured"),
      };
    }

    const firstTx = blockscoutRequests.txlist(explorer, address, "asc", 1);
    const firstTransfer = blockscoutRequests.tokentx(explorer, address, "asc", 1);
    const recent = blockscoutRequests.tokentx(explorer, address, "desc", TRANSFER_PAGE);
    const [rn, r1, r2, r3] = yield [nonceSpec, firstTx, firstTransfer, recent];
    const nonce = read(nonceSpec, rn, parseRpcQuantity);
    const tx = read(firstTx, r1, parseFirstTransaction);
    const tr = read(firstTransfer, r2, (b) => parseTransfers(b, address, 1));
    const page = read(recent, r3, (b) => parseTransfers(b, address, TRANSFER_PAGE));
    for (const g of [nonce, tx, tr, page]) if (!g.ok) note(g);

    // Age: the oldest sign of life in either list. One list alone is a later (safer) date.
    let firstSeenAt: Evidence<number | null>;
    if (tx.ok && tr.ok) {
      const a = tx.value;
      const b = tr.value.firstAt;
      if (a === null && b === null) firstSeenAt = evidence.ok<number | null>(null, "blockscout.txlist");
      else if (b === null || (a !== null && a <= b)) firstSeenAt = evidence.ok<number | null>(a, "blockscout.txlist");
      else firstSeenAt = evidence.ok<number | null>(b, "blockscout.tokentx");
    } else if (tx.ok) firstSeenAt = evidence.fallback<number | null>(tx.value, "blockscout.txlist", "token transfers unavailable");
    else if (tr.ok) firstSeenAt = evidence.fallback<number | null>(tr.value.firstAt, "blockscout.tokentx", "transactions unavailable");
    else firstSeenAt = lost<number | null>(null, "blockscout.txlist", "explorer unavailable", [failure(tx), failure(tr)]);

    // Sent: transactions it paid for (its nonce) or transfers it signed, whichever is larger.
    let sentCount: Evidence<number>;
    if (nonce.ok && page.ok) {
      const n = safe(nonce.value);
      sentCount = page.value.sent > n ? evidence.ok(page.value.sent, "blockscout.tokentx") : evidence.ok(n, "rpc.nonce");
    } else if (page.ok) sentCount = evidence.fallback(page.value.sent, "blockscout.tokentx", "nonce unavailable");
    else if (nonce.ok) sentCount = evidence.fallback(safe(nonce.value), "rpc.nonce", "token transfers unavailable");
    else sentCount = lost(0, "rpc.nonce", "rpc and explorer unavailable", [failure(nonce), failure(page)]);

    return { firstSeenAt, sentCount };
  }

  const [stableBalance, act] = yield* all<[Evidence<number>, Pick<SubjectEvidence, "firstSeenAt" | "sentCount">]>([balance(), activity()]);
  return {
    issues,
    evidence: { address, role: "account", ...act, stableBalance, ...accountRules() },
  };
}

// ------------------------------------------------------------------ a linked history wallet

export function* linkedRecipe(address: Address, o: RecipeOptions): Recipe<Collected> {
  const issues: Issue[] = [];
  const note = (g: { issue: Omit<Issue, "subject"> }) => issues.push({ subject: "linked", ...g.issue });
  const edges = o.probeEdgesDays ?? PROBE_EDGES_DAYS;
  const pools = o.liquidationPools ?? LIQUIDATION_POOLS;
  const rpcUrls = o.historyRpcUrls ?? HISTORY_CHAINS.map((c) => c.rpcUrl);
  const now = o.now;

  function* sent(): Recipe<Evidence<number>> {
    const specs = rpcUrls.map((url) => rpcRequests.transactionCount(url, address));
    const replies = specs.length ? yield specs : [];
    let total = 0n;
    let failed: Failed | null = null;
    for (const [i, spec] of specs.entries()) {
      const g = read(spec, replies[i], parseRpcQuantity);
      if (!g.ok) {
        note(g);
        failed = g;
        break;
      }
      total += g.value;
    }
    if (!failed) return evidence.ok(safe(total), "rpc.nonce");
    const z = yield* askZerion(zerionRequests.transactions(address, { pageSize: 100, trash: "only_non_trash" }), parseTransactions);
    if (z.ok) {
      if (z.value === "not-trackable") return evidence.empty(0, "zerion.transactions", "nonces unavailable; zerion: not trackable");
      const rows = countedRows(z.value);
      return evidence.fallback(z.value.hasNext ? Math.max(rows.length, 100) : rows.length, "zerion.transactions", "nonces unavailable; capped at 100");
    }
    note(z);
    return lost(0, "rpc.nonce", "nonces and zerion unavailable", [failed, failure(z)]);
  }

  function* balance(): Recipe<Evidence<number>> {
    const z = yield* askZerion(zerionRequests.positions(address), parsePositionsStables);
    if (z.ok && z.value !== "not-trackable") return evidence.ok(z.value, "zerion.positions");
    if (!z.ok) note(z);
    const n = yield* ask(nansenRequests.currentBalance(address), parseCurrentBalanceStables);
    if (n.ok) return evidence.fallback(n.value, "nansen.current-balance", z.ok ? "zerion: not trackable" : "zerion unavailable");
    note(n);
    if (z.ok) return evidence.empty(0, "zerion.positions", "not trackable");
    return lost(0, "zerion.positions", "zerion and nansen unavailable", [failure(z), failure(n)]);
  }

  function* defi(): Recipe<Evidence<number | null>> {
    const z = yield* probeSince(address, now, edges, { operationTypes: ["trade", "deposit", "withdraw"] });
    if (z.ok && !z.value.notTrackable) return evidence.ok(z.value.since, "zerion.probe");
    if (!z.ok) note(z);
    // Nansen: the oldest DEX trade in the last year (a year is the documented range cap).
    const n = yield* ask(nansenRequests.transactions(address, "all", now - 365 * DAY_SECONDS, now, { sourceType: "dex", perPage: 1, direction: "ASC" }), parseOldestTransaction);
    if (n.ok) return evidence.fallback(n.value, "nansen.transactions", "zerion unavailable; last year only");
    note(n);
    if (z.ok) return evidence.empty<number | null>(null, "zerion.probe", "not trackable");
    return lost<number | null>(null, "zerion.probe", "zerion and nansen unavailable", [failure(z), failure(n)]);
  }

  function* liquidations(): Recipe<Evidence<number>> {
    const chains = Object.entries(pools).filter(([, list]) => list.length > 0);
    const specs = chains.map(([id]) => etherscanRequests.liquidationLogs(Number(id), address));
    const replies = specs.length ? yield specs : [];
    let total = 0;
    for (const [i, spec] of specs.entries()) {
      const g = read(spec, replies[i], (b) => parseLiquidationCount(b, chains[i]![1]));
      // No fallback: neither Nansen nor Zerion exposes liquidations, and a zero here would hide a risk.
      if (!g.ok) {
        note(g);
        return lost(0, "etherscan.logs", "etherscan unavailable", [g]);
      }
      total += g.value;
    }
    return evidence.ok(total, "etherscan.logs");
  }

  const labelsRecipe = o.useNansenLabels ? ask(nansenRequests.labels(address), parseLabels) : nothing(null);
  const [funderGot, sentCount, stableBalance, defiSince, liquidationCount, labelsGot] = yield* all<
    [Got<Funder | null>, Evidence<number>, Evidence<number>, Evidence<number | null>, Evidence<number>, Got<Array<{ label: string; category: string }>> | null]
  >([ask(nansenRequests.firstFunder(address), parseFirstFunder), sent(), balance(), defi(), liquidations(), labelsRecipe]);

  // The funder, and what depends on it.
  let funder: Evidence<Funder | null>;
  if (funderGot.ok) {
    funder = funderGot.value
      ? evidence.ok<Funder | null>(funderGot.value, "nansen.first-funder")
      : evidence.empty<Funder | null>(null, "nansen.first-funder", "no first-funder attribution");
  } else {
    note(funderGot);
    funder = lost<Funder | null>(null, "nansen.first-funder", "nansen unavailable", [funderGot]);
  }
  const funderUnread = funder.status === "missing" || funder.status === "not_configured";
  const f = funderUnread ? null : funder.value;
  /** What depends on the funder inherits why it could not be read. */
  const noFunder = <T>(value: T, source: string, detail: string): Evidence<T> =>
    funder.status === "not_configured" ? evidence.notConfigured(value, source, funder.detail) : evidence.missing(value, source, detail);

  function* age(): Recipe<Evidence<number | null>> {
    if (f && f.fundedAt !== null) return evidence.ok<number | null>(f.fundedAt, "nansen.first-funder");
    const why = funder.status === "missing" ? "nansen unavailable" : funder.status === "not_configured" ? "nansen not configured" : "no first-funder attribution";
    const z = yield* probeSince(address, now, edges, {});
    if (z.ok) {
      return z.value.notTrackable
        ? evidence.empty<number | null>(null, "zerion.probe", `${why}; zerion: not trackable`)
        : evidence.fallback(z.value.since, "zerion.probe", why);
    }
    note(z);
    return lost<number | null>(null, "zerion.probe", `${why}; zerion unavailable`, [failure(funderGot), failure(z)]);
  }

  function* related(): Recipe<Evidence<number>> {
    if (funderUnread) return noFunder(0, "nansen.related-wallets", "first funder unknown");
    if (!f) return evidence.empty(0, "nansen.related-wallets", "no funder, so no cluster by funder");
    if (exchangeIn(f.name) || riskIn(f.name)) return evidence.ok(0, "nansen.first-funder");
    if (!NANSEN_RELATED_CHAINS.has(f.chain)) return evidence.empty(0, "nansen.related-wallets", `chain ${f.chain} not supported`);
    const r = yield* ask(nansenRequests.relatedWallets(f.address, f.chain), (b) => parseRelatedWallets(b, [f.address, address]));
    if (r.ok) return evidence.ok(r.value.count, "nansen.related-wallets");
    note(r);
    return lost(0, "nansen.related-wallets", "nansen unavailable", [failure(r)]);
  }

  const [firstSeenAt, relatedWallets] = yield* all<[Evidence<number | null>, Evidence<number>]>([age(), related()]);

  let riskLabel: Evidence<string | null>;
  if (funderUnread) riskLabel = noFunder<string | null>(null, "nansen.first-funder", "first funder unknown");
  else if (riskIn(f?.name)) riskLabel = evidence.ok<string | null>(riskIn(f?.name), "nansen.first-funder");
  else if (labelsGot && !labelsGot.ok) {
    note(labelsGot);
    riskLabel = lost<string | null>(null, "nansen.labels", "labels unavailable", [failure(labelsGot)]);
  } else if (labelsGot?.ok) riskLabel = evidence.ok(firstRisk(labelsGot.value.map((x) => x.label)), "nansen.labels");
  else riskLabel = evidence.ok<string | null>(null, "nansen.first-funder");

  return {
    issues,
    evidence: {
      address,
      role: "linked",
      firstSeenAt,
      sentCount,
      stableBalance,
      defiSince,
      liquidations: liquidationCount,
      funder,
      relatedWallets,
      riskLabel,
    },
  };
}

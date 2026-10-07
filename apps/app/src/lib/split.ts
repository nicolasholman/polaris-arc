import { encodeAbiParameters, type Hex, keccak256 } from "viem";
import { amountParam, type Micros, parseAmount, usd } from "./money.ts";

/**
 * Split-the-bill links: the words, and how a link carries them.
 *
 * A split lives on chain as amounts and who paid them (PolarisSplit). Its
 * words (what it's for, the organiser's name, a label for each share) never
 * go there, and never to Polaris's servers: they travel in the link's
 * fragment, which browsers don't send anywhere, like a send link's sender
 * name. The organiser signs their hash (`memoHash`), so the app can tell
 * whether the words in a link are the organiser's before it shows them.
 *
 *   /split/<splitId>#d=Dinner+at+Lucia&n=Maya&t=120&l=Sam&l=Priya&l=Jon
 *
 * The device that made a split (or opened its link) keeps the words and the
 * link, so its Activity can say "Sam paid their share · Dinner at Lucia" and
 * Remind can share the same link again.
 */

export type SplitMemo = {
  /** What it's for: "Dinner at Lucia". */
  description: string;
  /** Who is asking: the name the organiser chose on their device. */
  organiserName: string;
  /** The whole bill, which may include the organiser's own part; the shares are what friends owe. */
  billTotal: Micros;
  /** One per share: a friend's name, or "" for an unnamed equal share. */
  labels: string[];
};

/** PolarisSplit.MAX_SHARES; the app offers up to MAX_PEOPLE people (you and 19 friends). */
export const MAX_SHARES = 50;
export const MAX_PEOPLE = 20;
/** How long a split stays payable. PolarisSplit allows 5 minutes to 60 days. */
export const SPLIT_LIFETIME_DAYS = 14;

const LIMITS = { description: 60, name: 40, label: 24 } as const;

/** Display text from a link: control characters out, trimmed, capped. */
export function cleanText(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

/**
 * keccak256(abi.encode(string description, string organiserName, uint256
 * billTotal, string[] labels)): what the organiser signs as `memoHash`. The
 * contract only stores it; packages/contracts' suite hashes the same way.
 */
export function memoHash(memo: SplitMemo): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "string[]" }],
      [memo.description, memo.organiserName, memo.billTotal, memo.labels],
    ),
  );
}

/**
 * `total` in `n` shares that add up to it exactly, to the micro-dollar: the
 * first `total mod n` shares carry one micro-dollar more. $100 in 3 is
 * $33.333334 + $33.333333 + $33.333333, shown as $33.33 each.
 */
export function equalShares(total: Micros, n: number): Micros[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("a split needs at least one share");
  const N = BigInt(n);
  const base = total / N;
  const extra = total % N;
  return Array.from({ length: n }, (_, i) => base + (BigInt(i) < extra ? 1n : 0n));
}

/** The link friends open: the split's id in the path, its words in the fragment. */
export function splitUrl(origin: string, splitId: Hex, memo: SplitMemo): string {
  const params = new URLSearchParams();
  if (memo.description) params.set("d", memo.description);
  if (memo.organiserName) params.set("n", memo.organiserName);
  params.set("t", amountParam(memo.billTotal));
  for (const label of memo.labels) params.append("l", label);
  return `${origin}/split/${splitId.toLowerCase()}#${params.toString()}`;
}

/** The words in a link's fragment, or null when there are none to read. They are checked against `memoHash` before use. */
export function parseSplitFragment(hash: string): SplitMemo | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (![...params.keys()].length) return null;
  const labels = params.getAll("l").slice(0, MAX_SHARES).map((l) => cleanText(l, LIMITS.label));
  const billTotal = parseAmount(params.get("t") ?? "") ?? 0n;
  return {
    description: cleanText(params.get("d") ?? "", LIMITS.description),
    organiserName: cleanText(params.get("n") ?? "", LIMITS.name),
    billTotal,
    labels,
  };
}

/** A share's name: the organiser's label, else "Share 2". */
export function shareLabel(memo: SplitMemo | null, index: number): string {
  return memo?.labels[index] || `Share ${index + 1}`;
}

/** Whether the words (from a link, or this device) are the ones the organiser signed. */
export function memoMatches(memo: SplitMemo | null, hash: Hex): memo is SplitMemo {
  return memo !== null && memoHash(memo).toLowerCase() === hash.toLowerCase();
}

/* ── The create form ────────────────────────────────────────────────────── */

/** Equally between some people, or by named amounts. */
export type SplitMode = "equal" | "custom";
export type SplitRow = { name: string; amount: string };

/** The smallest share: the relayer's minimum (a share is a payment it carries). */
export const MIN_SHARE: Micros = 100_000n;

export type SplitPlan =
  | { ok: true; amounts: Micros[]; labels: string[]; collect: Micros; yourPart: Micros; each: Micros | null }
  | { ok: false; reason: string | null };

/**
 * The shares a form describes, or why it can't be made yet (null: nothing
 * to say, the form is just not filled in). Pure, so it is tested alone.
 */
export function planSplit(input: { bill: Micros; mode: SplitMode; people: number; includeMe: boolean; names: string[]; rows: SplitRow[] }): SplitPlan {
  const { bill, mode } = input;
  if (bill <= 0n) return { ok: false, reason: null };
  if (mode === "equal") {
    if (input.people < 2) return { ok: false, reason: "Split it between at least two people." };
    const all = equalShares(bill, input.people);
    // With you in, your share is yours: friends are asked for the rest.
    const friends = input.includeMe ? all.slice(1) : all;
    if (friends.some((a) => a < MIN_SHARE)) return { ok: false, reason: "Each share needs to be at least $0.10." };
    const labels = friends.map((_, i) => cleanText(input.names[i] ?? "", 24));
    const collect = friends.reduce((a, b) => a + b, 0n);
    return { ok: true, amounts: friends, labels, collect, yourPart: bill - collect, each: all[all.length - 1] ?? null };
  }
  const rows = input.rows.filter((r) => r.name.trim() || r.amount.trim());
  if (rows.length === 0) return { ok: false, reason: null };
  const amounts: Micros[] = [];
  for (const r of rows) {
    const a = parseAmount(r.amount || "0");
    if (!r.name.trim()) return { ok: false, reason: "Give every share a name." };
    if (a === null || a <= 0n) return { ok: false, reason: `Add ${cleanText(r.name, 24)}'s amount.` };
    if (a < MIN_SHARE) return { ok: false, reason: "Each share needs to be at least $0.10." };
    amounts.push(a);
  }
  const collect = amounts.reduce((a, b) => a + b, 0n);
  if (collect > bill) return { ok: false, reason: `That's ${usd(collect - bill)} more than the bill.` };
  return { ok: true, amounts, labels: rows.map((r) => cleanText(r.name, 24)), collect, yourPart: bill - collect, each: null };
}

/** What a link to /split/new can fill in: polarispay-sdk's `splits.link()` builds it. */
export type SplitPrefill = {
  /** The bill, as typed: "120" or "86.40". */
  amount?: string;
  description?: string;
  mode?: SplitMode;
  /** Everyone sharing the bill, including you unless `includeMe` is false. */
  people?: number;
  includeMe?: boolean;
  names?: string[];
  rows?: SplitRow[];
};

/**
 * The create form's starting values from its URL:
 *
 *   /split/new?amount=120&description=Dinner&people=4&name=Sam&name=Priya
 *   /split/new?amount=120&share=Sam:45&share=Priya:30.50
 *
 * Anything malformed is left out, never guessed; the organiser still reviews
 * every value and confirms with Face ID.
 */
export function splitPrefill(params: URLSearchParams): SplitPrefill {
  const out: SplitPrefill = {};
  const amount = (params.get("amount") ?? "").trim();
  if (parseAmount(amount) !== null && amount !== "") out.amount = amount;
  const description = cleanText(params.get("description") ?? "", LIMITS.description);
  if (description) out.description = description;
  const shares = params
    .getAll("share")
    .map((s) => {
      const i = s.lastIndexOf(":");
      return i > 0 ? { name: cleanText(s.slice(0, i), LIMITS.label), amount: s.slice(i + 1).trim() } : null;
    })
    .filter((r): r is SplitRow => r !== null && r.name !== "" && parseAmount(r.amount) !== null)
    .slice(0, MAX_PEOPLE - 1);
  if (shares.length) {
    out.mode = "custom";
    out.rows = shares;
    return out;
  }
  const people = Number(params.get("people"));
  if (Number.isInteger(people) && people >= 2 && people <= MAX_PEOPLE) out.people = people;
  if (params.get("include_me") === "0") out.includeMe = false;
  const names = params.getAll("name").map((n) => cleanText(n, LIMITS.label)).slice(0, MAX_PEOPLE);
  if (names.some((n) => n)) out.names = names;
  return out;
}

/* ── What this device knows ─────────────────────────────────────────────── */

export type KnownSplit = {
  memo: SplitMemo;
  /** The link, to share again (Remind). */
  url: string;
  /** Made here, or opened here from a link. */
  role: "organiser" | "friend";
  at: number;
};

const KEY = "polaris.splits.v1";
const EVENT = "polaris:splits";

function readAll(): Record<string, KnownSplit> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw, (_k, v: unknown) =>
      v && typeof v === "object" && typeof (v as { $big?: unknown }).$big === "string" ? BigInt((v as { $big: string }).$big) : v,
    ) as Record<string, KnownSplit>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The words and link this device keeps for a split, if any. */
export function knownSplit(splitId: Hex): KnownSplit | null {
  return readAll()[splitId.toLowerCase()] ?? null;
}

/**
 * Keep a split's words and link on this device. An organiser's entry is
 * never replaced by a friend's (opening your own link from a chat changes
 * nothing). Storage that is full or blocked just doesn't keep it.
 */
export function rememberSplit(splitId: Hex, entry: KnownSplit): void {
  if (typeof window === "undefined") return;
  try {
    const all = readAll();
    const id = splitId.toLowerCase();
    if (all[id]?.role === "organiser" && entry.role === "friend") return;
    all[id] = entry;
    // Keep the newest 200.
    const kept = Object.fromEntries(Object.entries(all).sort(([, a], [, b]) => b.at - a.at).slice(0, 200));
    window.localStorage.setItem(KEY, JSON.stringify(kept, (_k, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v)));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* not kept */
  }
}

/** Re-render when this device learns a split's words (another tab, or a link just opened). */
export function onKnownSplitsChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, listener);
  };
}

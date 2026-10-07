import { invalidRequest } from "./errors.js";
import { normaliseAmount, type AmountInput } from "./money.js";

/**
 * Split-the-bill links.
 *
 * A split is the organiser's own request for money from friends: the
 * organiser opens it with Face ID in the Polaris app (their signature is
 * what opens it on chain, PolarisSplit), shares one link, and each friend
 * pays their share there. So an app can't create a split for a person. It
 * can hand them a link to the Polaris app's "Split a bill" screen, filled in
 * (a restaurant's "Split this bill", a ride's "Split the fare"), where they
 * review it and confirm:
 *
 *   polaris.splits.link({ total: "120.00", description: "Dinner at Lucia", people: 4 })
 *   polaris.splits.link({ total: "120.00", shares: [{ name: "Sam", amount: "45" }, { name: "Priya", amount: "30.50" }] })
 *
 * and read a split's status from its id (server: `polaris.splits.retrieve`).
 */

export type SplitShareInput = { name: string; amount: AmountInput };

export type SplitLinkParams = {
  /** The whole bill, in dollars. */
  total: AmountInput;
  /** What it's for, up to 60 characters. */
  description?: string;
  /**
   * Split equally between this many people (2 to 20), counting the organiser
   * unless `includeOrganiser` is false. Ignored when `shares` are given.
   */
  people?: number;
  /** Whether the organiser is one of `people` (their share stays theirs). Default true. */
  includeOrganiser?: boolean;
  /** Friends' names for an equal split, in order. Optional. */
  names?: string[];
  /** Named amounts instead of an equal split: what each friend owes (up to 19). What's left of the bill is the organiser's. */
  shares?: SplitShareInput[];
};

const MAX_PEOPLE = 20;

/**
 * The Polaris app's "Split a bill" screen, filled in: `${appOrigin}/split/new?…`.
 * Nothing is created until the organiser confirms there.
 */
export function splitLink(appOrigin: string, params: SplitLinkParams): string {
  if (!params || typeof params !== "object") throw invalidRequest("invalid_split", "splits.link({ total, … })", "params");
  const q = new URLSearchParams();
  q.set("amount", normaliseAmount(params.total, "total"));
  const description = (params.description ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (description.length > 60) throw invalidRequest("invalid_split", "description can be at most 60 characters.", "description");
  if (description) q.set("description", description);
  if (params.shares?.length) {
    if (params.shares.length > MAX_PEOPLE - 1) throw invalidRequest("invalid_split", `At most ${MAX_PEOPLE - 1} shares.`, "shares");
    for (const [i, share] of params.shares.entries()) {
      const name = String(share?.name ?? "").replace(/[\u0000-\u001f\u007f:]/g, "").trim();
      if (!name) throw invalidRequest("invalid_split", `shares[${i}].name is required.`, `shares[${i}].name`);
      q.append("share", `${name.slice(0, 24)}:${normaliseAmount(share.amount, `shares[${i}].amount`)}`);
    }
  } else {
    const people = params.people ?? 2;
    if (!Number.isInteger(people) || people < 2 || people > MAX_PEOPLE) {
      throw invalidRequest("invalid_split", `people must be a whole number from 2 to ${MAX_PEOPLE}.`, "people");
    }
    q.set("people", String(people));
    if (params.includeOrganiser === false) q.set("include_me", "0");
    for (const name of params.names ?? []) q.append("name", String(name).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24));
  }
  return `${appOrigin.replace(/\/+$/, "")}/split/new?${q.toString()}`;
}

/** A split as `GET /api/public/splits/{id}` serves it. Money in base units (6 decimals), as strings. */
export type SplitStatus = {
  id: string;
  organiser: string;
  status: "open" | "settled" | "closed" | "expired";
  totalUnits: string;
  paidUnits: string;
  shareCount: number;
  paidCount: number;
  expiresAt: string;
  /** keccak256 of the split's words, which travel in its link and never reach Polaris. */
  memoHash: string;
  shares: Array<{ index: number; amountUnits: string; paid: boolean; payer: string | null; paidAt: string | null; txHash: string | null; explorerUrl: string | null }>;
  createdAt: string | null;
  createdTxHash: string | null;
  closedAt: string | null;
};

/** A split id: 32 bytes of hex. */
export function assertSplitId(id: unknown): string {
  if (typeof id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(id)) throw invalidRequest("invalid_split_id", "A split id is 0x followed by 64 hex characters.", "id");
  return id.toLowerCase();
}

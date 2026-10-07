"use client";

import { Coin, TableName, type CoinTone, type StatusPillTone } from "@polaris/ui";

import { shortAddress } from "@/lib/data/format";
import type { PayMode, Payment } from "@/lib/data/types";

/** Each mode in ref E's pill colours: lime, purple, teal. */
export const MODE_COLOR: Record<PayMode, string> = {
  now: "var(--ui-lime-button)",
  later: "var(--ui-pill-purple-text)",
  subscribe: "var(--ui-pill-teal-text)",
};

export const MODE_COIN: Record<PayMode, CoinTone> = { now: "lime", later: "purple", subscribe: "teal" };

/** A payment's pill, in ref E's colours: how it was paid, or that it failed. */
export function paymentPill(p: Payment): { tone: StatusPillTone; text: string } {
  if (p.status === "failed") return { tone: "red", text: "Failed" };
  if (p.mode === "later") return { tone: "purple", text: "Pay in 4" };
  if (p.mode === "subscribe") return { tone: "teal", text: "Subscription" };
  return { tone: "lime", text: "Paid" };
}

/** A small round coin in a mode's colour with the item's first letter, like the reference's exchange icons. */
export function ModeCoin({ mode, text, size = 28 }: { mode: PayMode; text: string; size?: number }) {
  return (
    <Coin tone={MODE_COIN[mode]} size={size}>
      <span style={{ fontSize: Math.round(size * 0.47) }}>{text.trim()[0]?.toUpperCase() ?? "·"}</span>
    </Coin>
  );
}

const BUYER_TONES: CoinTone[] = ["lime", "blue", "purple", "teal", "orange"];

/**
 * A buyer's coin: its colour and two characters from the buyer's address,
 * so the same buyer looks the same on every row and every page (not the
 * first letter of whatever they bought).
 */
export function BuyerCoin({ address, size = 28 }: { address: string; size?: number }) {
  const hex = address.toLowerCase().replace(/^0x/, "");
  const tone = BUYER_TONES[parseInt(hex.slice(-6) || "0", 16) % BUYER_TONES.length]!;
  return (
    <Coin tone={tone} size={size}>
      <span className="ui-figure" style={{ fontSize: Math.round(size * 0.4) }}>
        {hex.slice(0, 2).toUpperCase() || "·"}
      </span>
    </Coin>
  );
}

/**
 * The first column: the coin and the buyer, with what they bought under it
 * when there's room. On phones, where the Status column is hidden, the sub
 * line leads with it ("Pay in 4 · Website audit"), like the app's activity
 * rows.
 */
/**
 * A payment's buyer, with a sub line. `sub`: the status (below sm) and the
 * description, always. `"fold"`: only what a table hides, the status below sm
 * and the description below xl (where it has no Item column).
 */
export function PaymentName({ p, sub }: { p: Payment; sub?: boolean | "fold" }) {
  return (
    <TableName
      // Never wider than the table can give it: a long item or order line truncates instead of pushing Amount off screen.
      className="max-w-[min(44vw,236px)]"
      icon={<BuyerCoin address={p.buyer} />}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="ui-figure truncate">{shortAddress(p.buyer, 6, 4)}</span>
        </span>
      }
      sub={
        sub === "fold" ? (
          <span className="xl:hidden">
            <span className="sm:hidden">{paymentPill(p).text} · </span>
            {p.description}
          </span>
        ) : sub ? (
          <>
            <span className="sm:hidden">{paymentPill(p).text} · </span>
            {p.description}
          </>
        ) : undefined
      }
    />
  );
}

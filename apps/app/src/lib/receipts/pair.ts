import type { Hex } from "viem";

/** A row of the buyer book's receipt index: which transaction has a sealed receipt, never what is in it. */
export type ReceiptIndexEntry = { id: string; kind: string; txHash: Hex | null; amountUnits: string | null };

/**
 * Pairs activity rows with their sealed receipts. A payment row names its
 * receipt (the receipt id is the payment's id); a row built from a move (an
 * instalment collected) has none to name, so it takes the unclaimed receipt
 * of the same transaction, by amount when the transaction has several.
 * Returns row id → receipt id.
 */
export function pairReceipts<T extends { id: string; txHash: Hex; amount: bigint }>(
  rows: readonly T[],
  index: readonly ReceiptIndexEntry[],
  /** The receipt id a row names, or null for a row that names none. */
  named: (row: T) => string | null,
): Map<string, string> {
  const ids = new Set(index.map((r) => r.id));
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const row of rows) {
    const id = named(row);
    if (id !== null && ids.has(id) && !used.has(id)) {
      out.set(row.id, id);
      used.add(id);
    }
  }
  for (const row of rows) {
    if (out.has(row.id) || named(row) !== null) continue;
    const sameTx = index.filter((r) => !used.has(r.id) && r.txHash !== null && r.txHash.toLowerCase() === row.txHash.toLowerCase());
    const match = sameTx.find((r) => r.amountUnits === row.amount.toString()) ?? (sameTx.length === 1 ? sameTx[0] : undefined);
    if (match) {
      out.set(row.id, match.id);
      used.add(match.id);
    }
  }
  return out;
}

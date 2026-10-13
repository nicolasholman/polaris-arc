"use client";

import { cn } from "@polaris/ui";
import { eurosInDollars, freshRate, rateText } from "@/lib/cross-chain";
import { useData } from "@/lib/data/hooks";
import { type Micros, usd } from "@/lib/money";
import { getNetwork } from "@/lib/network";

/**
 * The euro's worth in dollars from Chainlink's EURC / USD Data Feed on Arc,
 * as Polaris for Business reports it (`network.rates`): "≈ $54.21 · 1 EURC =
 * $1.0842, Chainlink Data Feed on Arc". Display only, never used to price or
 * settle; nothing at all when there is no fresh rate.
 */
export function EurcRate({ euros, className }: { euros?: Micros; className?: string }) {
  const network = useData(async () => (await getNetwork()) ?? null, []);
  const rate = freshRate(network.value?.rates?.eurcUsd);
  if (!rate) return null;
  const updated = new Date(rate.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <span className={cn("ui-figure text-ui-muted", className)} title={`Display only. Chainlink EURC / USD read from Arc mainnet (the testnet has no feeds), updated ${updated}. Euros stay euros.`}>
      {euros !== undefined && euros > 0n ? (
        <span className="whitespace-nowrap">
          <span aria-hidden>≈{" "}</span>
          <span className="sr-only">About </span>
          {usd(eurosInDollars(euros, rate))} ·{" "}
        </span>
      ) : null}
      <span className="whitespace-nowrap">1 EURC = {rateText(rate)}</span>
      <span className="whitespace-nowrap">, Chainlink Data Feed, Arc mainnet</span>
    </span>
  );
}

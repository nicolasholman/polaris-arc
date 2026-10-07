import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn";

export type TxLinkProps = {
  /** A transaction hash or an address. */
  hash: string;
  /** The explorer page. Without one (a local chain) the hash is shown, not linked. */
  href?: string | null;
  /** Replaces the shortened hash ("View report"). */
  children?: ReactNode;
  /** Characters kept at each end: `0x4a3f…9c21` is 6 and 4. */
  head?: number;
  tail?: number;
  /** What the link opens, for its accessible name: "transaction", "report", "contract". */
  kind?: string;
  className?: string;
};

/** `0x4a3f…9c21`. */
export function shortHash(hash: string, head = 6, tail = 4): string {
  return hash.length > head + tail + 1 ? `${hash.slice(0, head)}…${hash.slice(-tail)}` : hash;
}

/**
 * A transaction (or contract) on the explorer: the shortened hash in figures
 * with an arrow, opening in a new tab. The full hash is its title. With no
 * explorer (a local chain) it is the same text, unlinked, so nothing points
 * at a page that doesn't exist.
 *
 * ```tsx
 * <TxLink hash={run.txHash} href={run.explorerUrl} />
 * <TxLink hash={report.txHash} href={url} kind="report">View report</TxLink>
 * ```
 */
export function TxLink({ hash, href, children, head = 6, tail = 4, kind = "transaction", className }: TxLinkProps) {
  const text = children ?? shortHash(hash, head, tail);
  if (!href) {
    return (
      <span title={hash} className={cn("ui-figure inline-flex items-center gap-1 font-satoshi text-ui-muted", className)}>
        {text}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={hash}
      aria-label={`${typeof text === "string" ? text : kind}: open the ${kind} ${shortHash(hash, head, tail)} on the explorer (new tab)`}
      className={cn(
        "ui-figure inline-flex items-center gap-1 rounded-md font-satoshi text-ui-muted underline-offset-4 transition-colors hover:text-ui-text hover:underline focus-visible:ring-2 focus-visible:ring-ui-focus focus-visible:outline-none",
        className,
      )}
    >
      {text}
      <ArrowUpRight aria-hidden size={14} strokeWidth={1.75} className="shrink-0" />
    </a>
  );
}

"use client";

import { AdaptiveSheet, Button, DetailsList, type KeyValue, Sheet, type SnapPoint, SuccessCheck } from "@polaris/ui";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

export type SuccessSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Paid.", "Sent.", "Arrived." */
  title: string;
  /** One line under it. */
  subtitle?: ReactNode;
  rows?: KeyValue[];
  /** The explorer page: the only road there is "View receipt". */
  receiptUrl?: string | null;
  /** Replaces "Done" (a merchant's return, say). */
  primary?: { label: string; onClick: () => void };
  /** Extra content under the rows (a link to share). */
  children?: ReactNode;
  snapPoints?: SnapPoint[];
};

/** The receipt that slides up when money moved: a check that draws itself, and what happened. */
export function SuccessSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  rows = [],
  receiptUrl,
  primary,
  children,
  snapPoints = ["half"],
}: SuccessSheetProps) {
  return (
    <AdaptiveSheet open={open} onOpenChange={onOpenChange} snapPoints={snapPoints} aria-label={title} maxWidth={440}>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-2 pt-3 text-center lg:pt-8">
        {open ? <SuccessCheck label={title.replace(/\.$/, "")} size={80} /> : <span className="size-20" />}
        <h2 className="mt-3 text-[34px] leading-none font-semibold tracking-[-0.035em]">{title}</h2>
        {subtitle ? (
          <p role="status" className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
            {subtitle}
          </p>
        ) : null}
        {rows.length ? <DetailsList size="sm" items={rows} className="mt-3 w-full text-left" /> : null}
        {children ? <div className="mt-2 w-full">{children}</div> : null}
      </Sheet.Body>
      <Sheet.Footer className="lg:[&>*]:flex-1">
        {receiptUrl ? (
          <Button asChild variant="outline" size="lg" iconRight={<ExternalLink />}>
            <a href={receiptUrl} target="_blank" rel="noopener noreferrer">
              View receipt
            </a>
          </Button>
        ) : null}
        <Button variant="lime" size="lg" onClick={primary?.onClick ?? (() => onOpenChange(false))}>
          {primary?.label ?? "Done"}
        </Button>
      </Sheet.Footer>
    </AdaptiveSheet>
  );
}

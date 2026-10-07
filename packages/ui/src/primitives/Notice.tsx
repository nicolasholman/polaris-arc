import { AlertTriangle, CircleAlert, Info, RotateCcw, Sparkles } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";
import { Button } from "./Button";

/* ── Notice ──────────────────────────────────────────────────────────────── */

export type NoticeTone = "info" | "warn" | "down" | "lime" | "neutral";

const NOTICE_TONES: Record<NoticeTone, { box: string; icon: string }> = {
  neutral: { box: "bg-ui-surface-2", icon: "text-ui-muted" },
  info: { box: "bg-ui-blue/10 ring-1 ring-inset ring-ui-blue/20", icon: "text-ui-info" },
  warn: { box: "bg-[#f5a524]/10 ring-1 ring-inset ring-[#f5a524]/22", icon: "text-ui-warn" },
  down: { box: "bg-ui-down/10 ring-1 ring-inset ring-ui-down/25", icon: "text-ui-down" },
  lime: { box: "bg-ui-lime/10 ring-1 ring-inset ring-ui-lime/22", icon: "text-ui-lime" },
};

const NOTICE_ICONS: Record<NoticeTone, ReactNode> = {
  neutral: <Info />,
  info: <Info />,
  warn: <AlertTriangle />,
  down: <CircleAlert />,
  lime: <Sparkles />,
};

export type NoticeProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  tone?: NoticeTone;
  /** Replace the tone's icon, or `null` for none. */
  icon?: ReactNode | null;
  title?: ReactNode;
  children?: ReactNode;
  /** A Button or two, on the right (below on narrow screens). */
  action?: ReactNode;
  size?: "sm" | "md";
};

/**
 * An inline banner inside a page or a card: why a control is disabled, a
 * refresh that failed while older data stays on screen, a note about sample
 * data. Not a live region by default; pass `role="alert"` or `role="status"`
 * when it appears in response to something the person did.
 *
 * ```tsx
 * <Notice tone="warn" title="Showing data from 2 minutes ago" action={<Button size="sm" variant="outline">Retry</Button>}>
 *   The last refresh failed.
 * </Notice>
 * ```
 */
export function Notice({ tone = "neutral", icon, title, children, action, size = "md", className, ...props }: NoticeProps) {
  const t = NOTICE_TONES[tone];
  const glyph = icon === undefined ? NOTICE_ICONS[tone] : icon;
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-ui-row font-satoshi text-ui-text sm:flex-row sm:items-center",
        size === "sm" ? "px-3.5 py-3 text-[13px]" : "px-4 py-3.5 text-[14px]",
        t.box,
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {glyph ? (
          <IconSlot size={size === "sm" ? 16 : 18} className={cn("mt-px inline-grid shrink-0 place-items-center", t.icon)}>
            {glyph}
          </IconSlot>
        ) : null}
        <div className="min-w-0 leading-[1.45]">
          {title ? <p className="font-medium">{title}</p> : null}
          {children ? <div className={cn(title && "mt-0.5", "text-ui-muted")}>{children}</div> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{action}</div> : null}
    </div>
  );
}

/* ── ErrorState ──────────────────────────────────────────────────────────── */

export type ErrorStateProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  /** Shows a Retry button that calls this. */
  onRetry?: () => void;
  retryLabel?: string;
  /** More actions beside Retry (Sign out, Go home). */
  action?: ReactNode;
  icon?: ReactNode;
  size?: "sm" | "md";
};

/**
 * What a page or panel shows when it couldn't load: a coral icon well, what
 * happened in plain words, and a way forward. The message is announced.
 *
 * ```tsx
 * <ErrorState title="We couldn't load your payments" description={error} onRetry={reload} />
 * ```
 */
export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  retryLabel = "Try again",
  action,
  icon,
  size = "md",
  className,
  ...props
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center text-center font-satoshi",
        size === "sm" ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "mb-1 grid place-items-center rounded-full bg-ui-down/12 text-ui-down",
          size === "sm" ? "size-12" : "size-16",
        )}
      >
        <IconSlot size={size === "sm" ? 20 : 26}>{icon ?? <CircleAlert />}</IconSlot>
      </span>
      <h3 className={cn("font-medium tracking-[-0.015em] text-ui-text", size === "sm" ? "text-[16px]" : "text-[19px]")}>{title}</h3>
      {description ? <p className="max-w-[44ch] text-[14px] leading-[1.45] text-ui-muted">{description}</p> : null}
      {onRetry || action ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <Button variant="white" size="sm" icon={<RotateCcw />} onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}

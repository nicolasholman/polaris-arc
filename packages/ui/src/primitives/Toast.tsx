"use client";

import { AlertCircle, Check, Info, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import { cn } from "../lib/cn";

export type ToastTone = "default" | "success" | "error" | "info";

export type ToastInput = {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** One action, like "Undo" or "View". */
  action?: { label: string; onClick: () => void };
  /** Milliseconds on screen; 0 keeps it until dismissed. Default 4500. */
  duration?: number;
  id?: string;
};

type ToastItem = ToastInput & { id: string; createdAt: number };

let items: ToastItem[] = [];
const listeners = new Set<() => void>();
const EMPTY: ToastItem[] = [];
let counter = 0;

function emit() {
  for (const l of listeners) l();
}

/**
 * Show a toast from anywhere (a <Toaster /> must be mounted once).
 *
 * ```ts
 * toast({ title: "Link copied", tone: "success" });
 * const id = toast({ title: "Payout sent", description: "$1,240.00 to your wallet" });
 * toast.dismiss(id);
 * ```
 */
export function toast(input: ToastInput): string {
  const id = input.id ?? `t${++counter}`;
  items = [...items.filter((t) => t.id !== id), { ...input, id, createdAt: Date.now() }].slice(-4);
  emit();
  return id;
}

toast.dismiss = (id?: string) => {
  items = id ? items.filter((t) => t.id !== id) : [];
  emit();
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const ICONS: Record<ToastTone, { icon: ReactNode; well: string }> = {
  default: { icon: <Info size={16} strokeWidth={2} />, well: "bg-ui-surface-2 text-ui-text" },
  info: { icon: <Info size={16} strokeWidth={2} />, well: "bg-ui-blue text-[#13141f]" },
  success: { icon: <Check size={16} strokeWidth={2.5} />, well: "bg-ui-lime text-ui-on-lime" },
  error: { icon: <AlertCircle size={16} strokeWidth={2} />, well: "bg-ui-down text-white" },
};

/**
 * Where toasts appear: bottom centre on phones, bottom right from 768px.
 * Always dark, like the references' floating chrome.
 *
 * ```tsx
 * <Toaster />
 * ```
 */
export function Toaster({ className }: { className?: string }) {
  const list = useSyncExternalStore(subscribe, () => items, () => EMPTY);
  return (
    <div
      data-theme="dark"
      role="region"
      aria-label="Notifications"
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-[1100] flex justify-center px-4 pb-[calc(16px+env(safe-area-inset-bottom))] font-satoshi text-ui-text md:justify-end md:px-6 md:pb-6",
        className,
      )}
    >
      <ol aria-live="polite" className="flex w-full max-w-[380px] flex-col gap-2">
        <AnimatePresence initial={false}>
          {list.map((t) => (
            <ToastCard key={t.id} item={t} />
          ))}
        </AnimatePresence>
      </ol>
    </div>
  );
}

function ToastCard({ item }: { item: ToastItem }) {
  const reduced = useReducedMotion();
  const tone = item.tone ?? "default";
  const duration = item.duration ?? 4500;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remaining = useRef(duration);
  const started = useRef(Date.now());

  const start = () => {
    if (duration === 0) return;
    started.current = Date.now();
    timer.current = setTimeout(() => toast.dismiss(item.id), remaining.current);
  };
  const pause = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    remaining.current -= Date.now() - started.current;
  };

  useEffect(() => {
    start();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const i = ICONS[tone];
  return (
    <motion.li
      layout={!reduced}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.96, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      onPointerEnter={pause}
      onPointerLeave={start}
      onFocus={pause}
      onBlur={start}
      role={tone === "error" ? "alert" : "status"}
      className="pointer-events-auto flex items-start gap-3 rounded-[20px] bg-ui-surface-3 p-3 pr-2 shadow-ui-pop"
    >
      <span aria-hidden className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-full", i.well)}>
        {i.icon}
      </span>
      <div className="min-w-0 flex-1 py-1">
        <p className="text-[15px] leading-[1.25] font-medium">{item.title}</p>
        {item.description ? <p className="mt-0.5 text-[13px] leading-[1.35] text-ui-muted">{item.description}</p> : null}
      </div>
      {item.action ? (
        <button
          type="button"
          onClick={() => {
            item.action!.onClick();
            toast.dismiss(item.id);
          }}
          className="mt-0.5 h-8 shrink-0 rounded-full bg-white px-3 text-[13px] font-medium text-[#13141f] transition-transform active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus"
        >
          {item.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => toast.dismiss(item.id)}
        className="grid size-8 shrink-0 place-items-center rounded-full text-ui-muted transition-colors hover:bg-ui-surface-2 hover:text-ui-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ui-focus"
      >
        <X aria-hidden size={16} strokeWidth={1.75} />
      </button>
    </motion.li>
  );
}

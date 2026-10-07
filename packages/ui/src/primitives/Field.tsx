"use client";

import { Check, ChevronDown } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../lib/cn";
import { useControllable, useMounted } from "../lib/hooks";
import { IconSlot } from "../lib/icon";
import { nestedTheme } from "./theme-scope";

/* ── Field wrapper ───────────────────────────────────────────────────────── */

type FieldChrome = {
  label?: ReactNode;
  /** Help under the field. */
  hint?: ReactNode;
  /** Replaces the hint and marks the field invalid. */
  error?: ReactNode;
  /** Visually hide the label (it is still read out). */
  hideLabel?: boolean;
};

function FieldFrame({
  id,
  label,
  hint,
  error,
  hideLabel,
  className,
  children,
}: FieldChrome & { id: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-2 font-satoshi", className)}>
      {label ? (
        <label id={`${id}-label`} htmlFor={id} className={cn("text-[14px] font-medium text-ui-muted", hideLabel && "sr-only")}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-msg`} className="text-[13px] text-ui-down">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="text-[13px] text-ui-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const fieldBox =
  "flex w-full items-center gap-2.5 rounded-ui-field font-satoshi text-ui-text transition-[box-shadow,background-color,border-color] duration-150 focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-ui-focus";

const FIELD_VARIANTS = {
  filled: "bg-ui-surface-2 hover:bg-ui-surface-3/70",
  outline: "border border-ui-hairline-strong bg-transparent hover:border-ui-muted/50",
} as const;

const FIELD_SIZES = {
  md: "h-12 px-4 text-[15px]",
  lg: "h-14 px-5 text-[17px]",
} as const;

/* ── Input ───────────────────────────────────────────────────────────────── */

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> &
  FieldChrome & {
    variant?: keyof typeof FIELD_VARIANTS;
    size?: keyof typeof FIELD_SIZES;
    /** An icon before the text (search, mail). */
    icon?: ReactNode;
    /** A node after the text: a unit, a button. */
    trailing?: ReactNode;
    /** Class for the outer wrapper (label + field). */
    wrapperClassName?: string;
  };

/**
 * A text field: filled (a surface-2 well) or outline, with a label, hint,
 * error and icon or trailing slots.
 *
 * ```tsx
 * <Input label="Business name" placeholder="Acme Coffee" />
 * <Input icon={<Search />} placeholder="Search payments" hideLabel label="Search" />
 * <Input label="Amount" trailing="USD" inputMode="decimal" error="Enter an amount" />
 * ```
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    error,
    hideLabel,
    variant = "filled",
    size = "md",
    icon,
    trailing,
    wrapperClassName,
    className,
    id: idProp,
    ...props
  },
  ref,
) {
  const auto = useId();
  const id = idProp ?? auto;
  const describedBy = error || hint ? `${id}-msg` : undefined;
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} hideLabel={hideLabel} className={wrapperClassName}>
      <div
        className={cn(
          fieldBox,
          FIELD_VARIANTS[variant],
          FIELD_SIZES[size],
          error && "outline-2 outline-ui-down/70",
          props.disabled && "pointer-events-none opacity-50",
        )}
      >
        {icon ? <IconSlot size={18} className="inline-grid shrink-0 place-items-center text-ui-muted">{icon}</IconSlot> : null}
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            // The ring is on the box; `!` keeps an app's own unlayered :focus-visible rule off the inner field.
            "h-full min-w-0 flex-1 bg-transparent outline-none! placeholder:text-ui-dim [&::-webkit-search-cancel-button]:hidden",
            className,
          )}
          {...props}
        />
        {trailing ? <span className="shrink-0 text-[14px] text-ui-muted">{trailing}</span> : null}
      </div>
    </FieldFrame>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  FieldChrome & { variant?: keyof typeof FIELD_VARIANTS; wrapperClassName?: string };

/** A multi-line field with the same chrome as Input. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, hideLabel, variant = "filled", wrapperClassName, className, id: idProp, rows = 3, ...props },
  ref,
) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} hideLabel={hideLabel} className={wrapperClassName}>
      <div className={cn(fieldBox, FIELD_VARIANTS[variant], "px-4 py-3 text-[15px]", error && "outline-2 outline-ui-down/70")}>
        <textarea
          ref={ref}
          id={id}
          rows={rows}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-msg` : undefined}
          className={cn("min-w-0 flex-1 resize-y bg-transparent leading-[1.45] outline-none! placeholder:text-ui-dim", className)}
          {...props}
        />
      </div>
    </FieldFrame>
  );
});

/* ── Select ──────────────────────────────────────────────────────────────── */

export type SelectOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  /** Plain text for type-ahead when `label` is a node. */
  text?: string;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
};

export type SelectProps<T extends string = string> = FieldChrome & {
  options: SelectOption<T>[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  placeholder?: string;
  /**
   * `outline`: ref D's "Every 2 Hours ▾".
   * `white`: ref C's "Market ▾" pill on a grey card.
   * `chip`: ref C's "Price ▾" inside the dark chart.
   * `filled`: a form field, like Input.
   */
  variant?: "outline" | "white" | "chip" | "filled";
  size?: "sm" | "md";
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  wrapperClassName?: string;
  /** Menu alignment against the trigger. */
  align?: "start" | "end";
  "aria-label"?: string;
};

const TRIGGER: Record<NonNullable<SelectProps["variant"]>, string> = {
  outline: "rounded-[14px] border border-ui-hairline-strong bg-transparent text-ui-text hover:bg-ui-surface-2",
  white: "rounded-full bg-white text-[#13141f] shadow-[0_1px_2px_rgb(19_20_31/0.06)] hover:bg-white/90",
  chip: "rounded-full bg-ui-candle-chip text-white hover:brightness-110",
  filled: "w-full justify-between rounded-ui-field bg-ui-surface-2 text-ui-text hover:bg-ui-surface-3/70",
};

/**
 * A custom listbox that looks like the references' dropdown pills. Arrow
 * keys, Home/End, type-ahead, Enter/Space, Escape; the menu is portalled,
 * keeps the trigger's theme, and flips above when there is no room below.
 *
 * ```tsx
 * <Select aria-label="Interval" variant="outline" options={[{ value: "2h", label: "Every 2 Hours" }]} />
 * <Select label="Payout wallet" variant="filled" options={wallets} />
 * ```
 */
export function Select<T extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Select",
  variant = "outline",
  size = "md",
  disabled,
  name,
  id: idProp,
  label,
  hint,
  error,
  hideLabel,
  className,
  wrapperClassName,
  align = "start",
  "aria-label": ariaLabel,
}: SelectProps<T>) {
  const auto = useId();
  const id = idProp ?? auto;
  const listId = `${id}-list`;
  const [current, setCurrent] = useControllable<T | undefined>({ value, defaultValue, onChange: onValueChange as (v: T | undefined) => void });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; above: boolean; theme: string | null }>({
    left: 0,
    top: 0,
    width: 0,
    above: false,
    theme: null,
  });
  const typeahead = useRef({ text: "", at: 0 });
  const mounted = useMounted();
  const reduced = useReducedMotion();

  const selected = options.find((o) => o.value === current);

  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const menuH = Math.min(320, options.length * 44 + 12);
    const above = r.bottom + menuH + 8 > window.innerHeight && r.top - menuH - 8 > 0;
    const width = Math.max(r.width, 200);
    const left = align === "end" ? r.right - width : r.left;
    setPos({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: above ? r.top - 8 : r.bottom + 8,
      width,
      above,
      theme: nestedTheme(t),
    });
  }, [align, options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => place();
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (open && active >= 0) {
      listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }, [open, active]);

  const enabledIndex = (from: number, step: 1 | -1) => {
    for (let i = 1; i <= options.length; i++) {
      const j = (from + step * i + options.length) % options.length;
      if (!options[j]!.disabled) return j;
    }
    return from;
  };

  const openMenu = (focus: "selected" | "first" | "last" = "selected") => {
    const sel = options.findIndex((o) => o.value === current);
    setActive(focus === "first" ? enabledIndex(-1, 1) : focus === "last" ? enabledIndex(0, -1) : sel >= 0 ? sel : enabledIndex(-1, 1));
    setOpen(true);
  };

  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setCurrent(o.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu(e.key === "ArrowUp" ? "last" : "selected");
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => enabledIndex(a, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => enabledIndex(a, -1));
        break;
      case "Home":
        e.preventDefault();
        setActive(enabledIndex(-1, 1));
        break;
      case "End":
        e.preventDefault();
        setActive(enabledIndex(0, -1));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const now = Date.now();
          const t = typeahead.current;
          t.text = now - t.at > 700 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
          t.at = now;
          const i = options.findIndex(
            (o) => !o.disabled && (o.text ?? (typeof o.label === "string" ? o.label : String(o.value))).toLowerCase().startsWith(t.text),
          );
          if (i >= 0) setActive(i);
        }
    }
  };

  const small = size === "sm";
  const trigger = (
    <button
      ref={triggerRef}
      id={id}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
      aria-label={label ? undefined : ariaLabel}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
      onClick={() => (open ? setOpen(false) : openMenu())}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex items-center gap-2 font-satoshi leading-none font-medium whitespace-nowrap transition-[background-color,transform,filter] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus disabled:opacity-40",
        variant === "filled" ? "h-12 px-4 text-[15px]" : small ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-[14px]",
        TRIGGER[variant],
        error && "outline-2 outline-ui-down/70",
        className,
      )}
    >
      {selected?.icon ? <IconSlot size={16}>{selected.icon}</IconSlot> : null}
      <span className={cn("truncate", !selected && "text-ui-dim")}>{selected ? selected.label : placeholder}</span>
      <ChevronDown
        aria-hidden
        size={small ? 14 : 16}
        strokeWidth={2}
        className={cn("-mr-1 shrink-0 opacity-70 transition-transform duration-200", open && "rotate-180")}
      />
    </button>
  );

  const menu =
    mounted &&
    createPortal(
      <AnimatePresence>
        {open ? (
          <motion.ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-labelledby={label ? `${id}-label` : undefined}
            aria-label={label ? undefined : ariaLabel}
            data-theme={pos.theme ?? undefined}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: pos.above ? 6 : -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: pos.above ? 4 : -4, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              width: pos.width,
              translate: pos.above ? "0 -100%" : undefined,
              transformOrigin: pos.above ? "bottom" : "top",
            }}
            className="z-[1000] max-h-[320px] overflow-y-auto rounded-[18px] bg-ui-surface-1 p-1.5 font-satoshi text-ui-text shadow-ui-pop"
          >
            {options.map((o, i) => {
              const isSel = o.value === current;
              return (
                <li
                  key={o.value}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled || undefined}
                  data-index={i}
                  onPointerEnter={() => !o.disabled && setActive(i)}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                  className={cn(
                    "flex min-h-10 cursor-pointer items-center gap-2.5 rounded-[12px] px-3 py-2 text-[14px] select-none",
                    i === active && "bg-ui-surface-2",
                    o.disabled && "cursor-not-allowed opacity-40",
                  )}
                >
                  {o.icon ? <IconSlot size={16}>{o.icon}</IconSlot> : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{o.label}</span>
                    {o.description ? <span className="block truncate text-[12px] text-ui-muted">{o.description}</span> : null}
                  </span>
                  {isSel ? <Check aria-hidden size={16} strokeWidth={2} className="shrink-0 text-ui-text" /> : null}
                </li>
              );
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>,
      document.body,
    );

  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} hideLabel={hideLabel} className={wrapperClassName}>
      {trigger}
      {name ? <input type="hidden" name={name} value={current ?? ""} /> : null}
      {menu}
    </FieldFrame>
  );
}

/* ── Toggle ──────────────────────────────────────────────────────────────── */

export type ToggleProps = {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  id?: string;
  "aria-label"?: string;
};

/**
 * A switch: lime when on.
 *
 * ```tsx
 * <Toggle label="Automatic payouts" description="Every day at 17:00" defaultChecked />
 * ```
 */
export function Toggle({
  checked,
  defaultChecked = false,
  onCheckedChange,
  label,
  description,
  disabled,
  size = "md",
  className,
  id: idProp,
  "aria-label": ariaLabel,
}: ToggleProps) {
  const [on, setOn] = useControllable({ value: checked, defaultValue: defaultChecked, onChange: onCheckedChange });
  const auto = useId();
  const id = idProp ?? auto;
  const reduced = useReducedMotion();
  const w = size === "sm" ? 36 : 48;
  const h = size === "sm" ? 22 : 28;
  const knob = h - 6;

  const control = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? `${id}-label` : undefined}
      aria-describedby={description ? `${id}-desc` : undefined}
      disabled={disabled}
      onClick={() => setOn(!on)}
      className={cn(
        "relative shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus disabled:opacity-40",
        on ? "bg-ui-lime" : "bg-[color-mix(in_oklab,var(--ui-text)_18%,transparent)]",
      )}
      style={{ width: w, height: h }}
    >
      <motion.span
        aria-hidden
        className={cn("absolute top-[3px] left-[3px] rounded-full shadow-[0_1px_3px_rgb(0_0_0/0.25)]", on ? "bg-[#0f1011]" : "bg-white")}
        style={{ width: knob, height: knob }}
        animate={{ x: on ? w - knob - 6 : 0 }}
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 600, damping: 35 }}
      />
    </button>
  );

  if (!label) return <span className={className}>{control}</span>;
  return (
    <div className={cn("flex items-center justify-between gap-4 font-satoshi", className)}>
      <div className="min-w-0">
        <label id={`${id}-label`} htmlFor={id} className="block text-[15px] font-medium text-ui-text">
          {label}
        </label>
        {description ? (
          <p id={`${id}-desc`} className="mt-0.5 text-[13px] text-ui-muted">
            {description}
          </p>
        ) : null}
      </div>
      {control}
    </div>
  );
}

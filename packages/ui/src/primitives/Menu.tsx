"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ElementType,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../lib/cn";
import { useMounted } from "../lib/hooks";
import { IconSlot } from "../lib/icon";
import { placeMenu, type MenuPosition } from "./menu-position";
import { pressable } from "./Button";
import { nestedTheme } from "./theme-scope";

type MenuContextValue = { close: (restoreFocus?: boolean) => void };
const MenuContext = createContext<MenuContextValue | null>(null);

function useMenu() {
  const ctx = useContext(MenuContext);
  if (!ctx) throw new Error("Menu.Item must be used inside a Menu.");
  return ctx;
}

export type MenuProps = {
  /** The trigger's accessible name ("Account"). */
  label: string;
  /** What the trigger shows: an Avatar, an icon, a label. */
  trigger: ReactNode;
  /** Classes for the trigger button. */
  triggerClassName?: string;
  /** Which edge of the trigger the menu lines up with. */
  align?: "start" | "end";
  /** Open upwards (a trigger at the bottom of the screen). Flips when there isn't room that way. */
  side?: "bottom" | "top";
  /** Menu width in px. */
  width?: number;
  children: ReactNode;
  className?: string;
};

/**
 * A dropdown menu on a button: the header avatar menu, row actions. Arrow
 * keys, Home and End move between items, Escape and Tab close it, and focus
 * goes back to the trigger. Non-item content (Menu.Header) sits between items.
 *
 * The menu is portalled to `<body>` and placed with fixed coordinates from the
 * trigger, so a scrolling or clipping ancestor (a table's `overflow-x-auto`)
 * never cuts it off. It follows the trigger on scroll and resize, flips to the
 * other side when there isn't room, and stays inside the viewport.
 *
 * ```tsx
 * <Menu label="Account" trigger={<Avatar name="Oat & Ember" />} align="end">
 *   <Menu.Header>Oat & Ember · ana@oat.studio</Menu.Header>
 *   <Menu.Item icon={<Copy />} onSelect={copy}>Copy payout address</Menu.Item>
 *   <Menu.Separator />
 *   <Menu.Item icon={<LogOut />} onSelect={signOut}>Sign out</Menu.Item>
 * </Menu>
 * ```
 */
export function Menu({
  label,
  trigger,
  triggerClassName,
  align = "end",
  side = "bottom",
  width = 280,
  children,
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const mounted = useMounted();
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusFirst = useRef<"first" | "last">("first");
  const [pos, setPos] = useState<MenuPosition | null>(null);

  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    setPos(
      placeMenu({
        trigger: t.getBoundingClientRect(),
        menuHeight: menuRef.current?.offsetHeight ?? 0,
        width,
        align,
        side,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        theme: nestedTheme(t),
      }),
    );
  }, [align, side, width]);

  // Placed before paint, then again once the menu has a height (to flip if needed).
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const list = items();
      (focusFirst.current === "last" ? list[list.length - 1] : list[0])?.focus();
    });
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusFirst.current = e.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      // The menu lives at the end of <body>: hand focus back to the trigger
      // rather than letting Tab leave the page.
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      list[(at + 1) % list.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[(at - 1 + list.length) % list.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1]?.focus();
    }
  };

  return (
    <MenuContext.Provider value={{ close }}>
      <div ref={rootRef} className={cn("relative inline-flex font-satoshi", className)}>
        <button
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => {
            focusFirst.current = "first";
            setOpen((o) => !o);
          }}
          onKeyDown={onTriggerKey}
          className={cn("rounded-full", pressable, triggerClassName)}
        >
          {trigger}
        </button>
      </div>
      {mounted
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  ref={menuRef}
                  id={id}
                  role="menu"
                  aria-label={label}
                  data-theme={pos?.theme ?? undefined}
                  onKeyDown={onMenuKey}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: pos?.above ? 6 : -6, scale: 0.98 }}
                  animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, y: pos?.above ? 4 : -4, scale: 0.98, transition: { duration: 0.12 } }}
                  transition={{ type: "spring", stiffness: 520, damping: 36 }}
                  style={{
                    position: "fixed",
                    left: pos?.left ?? 0,
                    top: pos?.top ?? 0,
                    width: pos?.width ?? width,
                    translate: pos?.above ? "0 -100%" : undefined,
                    transformOrigin: `${pos?.above ? "bottom" : "top"} ${align === "end" ? "right" : "left"}`,
                    // Not shown until it has been placed (the first layout pass).
                    visibility: pos ? undefined : "hidden",
                  }}
                  className="z-[1000] overflow-hidden rounded-[22px] bg-ui-surface-2 p-1.5 font-satoshi text-ui-text shadow-ui-pop"
                >
                  {children}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </MenuContext.Provider>
  );
}

export type MenuItemProps = Omit<HTMLAttributes<HTMLElement>, "onSelect"> & {
  icon?: ReactNode;
  /** Called on click, Enter or Space. The menu closes afterwards unless `keepOpen`. */
  onSelect?: () => void;
  /** Render as a link (Next.js Link) with `href`. */
  href?: string;
  linkAs?: ElementType;
  disabled?: boolean;
  /** `danger` for sign out and destructive actions. */
  tone?: "default" | "danger";
  keepOpen?: boolean;
  /** A line under the label. */
  description?: ReactNode;
  trailing?: ReactNode;
};

function MenuItem({
  icon,
  onSelect,
  href,
  linkAs: Link = "a",
  disabled = false,
  tone = "default",
  keepOpen = false,
  description,
  trailing,
  className,
  children,
  ...props
}: MenuItemProps) {
  const { close } = useMenu();
  const classes = cn(
    "flex w-full min-h-11 items-center gap-3 rounded-[16px] px-3 py-2 text-left text-[15px] outline-none transition-colors",
    "hover:bg-ui-surface-3 focus-visible:bg-ui-surface-3",
    tone === "danger" ? "text-ui-down" : "text-ui-text",
    disabled && "pointer-events-none opacity-45",
    className,
  );
  const inner = (
    <>
      {icon ? <IconSlot size={18} className="inline-grid shrink-0 place-items-center opacity-90">{icon}</IconSlot> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-tight">{children}</span>
        {description ? <span className="mt-0.5 block truncate text-[13px] leading-tight text-ui-muted">{description}</span> : null}
      </span>
      {trailing ? <span className="shrink-0 text-ui-muted">{trailing}</span> : null}
    </>
  );
  const select = () => {
    if (disabled) return;
    onSelect?.();
    if (!keepOpen) close(!href);
  };
  if (href) {
    return (
      <Link
        href={href}
        role="menuitem"
        tabIndex={-1}
        aria-disabled={disabled || undefined}
        className={classes}
        onClick={select}
        {...props}
      >
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      className={classes}
      onClick={select}
      {...(props as HTMLAttributes<HTMLButtonElement>)}
    >
      {inner}
    </button>
  );
}

function MenuHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-3 pt-2.5 pb-2", className)} {...props} />;
}

function MenuSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cn("mx-2 my-1.5 h-px bg-ui-hairline-strong", className)} />;
}

Menu.Item = MenuItem;
Menu.Header = MenuHeader;
Menu.Separator = MenuSeparator;

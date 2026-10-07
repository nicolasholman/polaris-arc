"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { BagIcon, CloseIcon, MenuIcon } from "@/components/icons";
import { Wordmark } from "@/components/wordmark";
import { useShop } from "@/lib/shop-context";

const NAV = [
  { href: "/shop", label: "Shop all" },
  { href: "/shop?category=audio", label: "Audio" },
  { href: "/shop?category=home", label: "Home" },
  { href: "/shop?category=objects", label: "Objects" },
  { href: "/products/coffee-club", label: "Coffee Club" },
];

export function Header() {
  const { count, ready, openDrawer, menuOpen, setMenuOpen } = useShop();
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const reduce = useReducedMotion();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A new page closes the menu (its links close it too, for a new ?category on the same page).
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname, setMenuOpen]);

  // While the menu is open: the page behind stays put, Escape closes it, and Tab stays inside it.
  useEffect(() => {
    if (!menuOpen) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    const close = () => {
      setMenuOpen(false);
      toggleRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab" && menuRef.current) {
        const focusable = [toggleRef.current, ...menuRef.current.querySelectorAll<HTMLElement>("a[href]")].filter(Boolean) as HTMLElement[];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, setMenuOpen]);

  const inCheckout = pathname.startsWith("/checkout");

  return (
    <header
      className={`sticky top-0 z-40 bg-ground transition-[box-shadow] duration-300 ${
        scrolled || menuOpen ? "shadow-[0_1px_0_var(--color-hair)]" : ""
      }`}
    >
      <div className="mx-auto grid h-16 max-w-[1440px] grid-cols-[1fr_auto_1fr] items-center px-4 sm:px-6 lg:h-[72px] lg:px-10">
        <nav aria-label="Main" className="flex items-center">
          <button
            ref={toggleRef}
            type="button"
            className="-ml-2 inline-flex h-11 w-11 items-center justify-center rounded-full xl:hidden"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <CloseIcon size={22} /> : <MenuIcon size={22} />}
          </button>
          <ul className="hidden items-center gap-7 xl:flex">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="text-[0.94rem] text-ink-2 transition-colors hover:text-ink">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <Link href="/" aria-label="Halcyon, home" onClick={() => setMenuOpen(false)} className="justify-self-center rounded-md">
          <Wordmark />
        </Link>

        <div className="flex items-center justify-end">
          {inCheckout ? (
            <Link href="/cart" className="inline-flex min-h-11 items-center text-[0.94rem] text-ink-2 hover:text-ink">
              Back to bag
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                openDrawer();
              }}
              className="-mr-2 inline-flex h-11 items-center gap-2 rounded-full px-2 text-[0.94rem]"
              aria-label={`Bag, ${count} ${count === 1 ? "item" : "items"}`}
            >
              <span className="hidden sm:inline">Bag</span>
              <span className="relative inline-flex">
                <BagIcon size={22} />
                {ready && count > 0 ? (
                  <motion.span
                    key={count}
                    initial={reduce ? false : { scale: 0.6 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 520, damping: 18 }}
                    className="num absolute -right-2 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ink px-1 text-[11px] font-semibold leading-none text-paper"
                  >
                    {count}
                  </motion.span>
                ) : null}
              </span>
            </button>
          )}
        </div>
      </div>

      <AnimatePresence>
        {menuOpen ? (
          <>
            <motion.div
              key="scrim"
              className="fixed inset-x-0 bottom-0 top-16 -z-10 bg-ink/20 lg:top-[72px] xl:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              onClick={() => setMenuOpen(false)}
              aria-hidden="true"
            />
            <motion.div
              key="menu"
              ref={menuRef}
              id="mobile-menu"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-x-0 top-full border-t border-hair bg-ground px-4 pb-8 pt-2 shadow-[0_24px_40px_-24px_rgb(29_28_26/0.25)] sm:px-6 lg:px-10 xl:hidden"
            >
              <ul className="divide-y divide-hair">
                {NAV.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} onClick={() => setMenuOpen(false)} className="display flex h-14 items-center text-[1.6rem]">
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </header>
  );
}

"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useReduced } from "@/components/motion/hooks";
import { EASE_REVEAL, WORD_BLUR } from "@/components/motion/tokens";
import { MenuIcon } from "@/components/ui/icons";
import { PolarisWordmark } from "@/components/ui/Logo";
import { nav, site } from "@/content";

/**
 * The page's banner: the navigation over the top of the hero, with its load
 * sequence. The logotype writes on left to right behind a clip mask, the
 * link pill fades in with its links blurring in,
 * "Get the app" pops in and "Log in" slides out from behind it, and the menu
 * button fades up last. It sits outside <main>, positioned over the hero.
 */
export function HeroNav() {
  const reduced = useReduced();
  const [ready, setReady] = useState(false);
  const go = ready || reduced;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Start on the first frame after mount, in step with the hero.
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    // Move focus into the menu when it opens.
    listRef.current?.querySelector("a")?.focus();
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") {
          setMenuOpen(false);
          buttonRef.current?.focus();
        }
        return;
      }
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  return (
    <header className="absolute inset-x-0 top-0 z-30">
      <nav
        aria-label="Main"
        className="relative flex items-center justify-between px-4 pt-4 md:px-8 md:pt-6 lg:px-12 lg:pt-[50px]"
      >
        {/* Links pill */}
        <motion.div
          className="rv hidden h-[54px] items-center gap-[27px] rounded-full bg-[rgba(20,17,12,0.42)] px-[26px] backdrop-blur-[14px] lg:flex"
          initial={{ opacity: 0 }}
          animate={go ? { opacity: 1 } : undefined}
          transition={{ delay: 0.08, duration: 0.6, ease: "easeOut" }}
        >
          {nav.links.map((link, i) => (
            <motion.a
              key={link.label}
              href={link.href}
              className="reveal-word text-[17px] tracking-[-0.02em] text-white/95 transition-opacity hover:opacity-70"
              initial={{ opacity: 0, filter: `blur(${WORD_BLUR}px)`, y: 6 }}
              animate={go ? { opacity: 1, filter: "blur(0px)", y: 0 } : undefined}
              transition={{ delay: 0.16 + i * 0.09, duration: 0.7, ease: EASE_REVEAL }}
            >
              {link.label}
            </motion.a>
          ))}
        </motion.div>

        {/* Wordmark: centred on desktop, left on phones */}
        <a
          href="#top"
          aria-label={`${site.name} home`}
          className="flex items-center gap-2 text-white lg:absolute lg:left-1/2 lg:top-[50px] lg:h-[54px] lg:-translate-x-1/2"
        >
          {/* The logotype writes on left to right behind a clip mask, the way the
              reference's wordmark does, sharpening as it lands; its own star
              on the swoosh arrives last. */}
          <motion.span
            className="rv inline-flex"
            initial={{ clipPath: "inset(-20% 100% -20% 0%)", filter: "blur(6px)", opacity: 0 }}
            animate={go ? { clipPath: "inset(-20% 0% -20% 0%)", filter: "blur(0px)", opacity: 1 } : undefined}
            transition={{ delay: 0.12, duration: 1.0, ease: EASE_REVEAL }}
          >
            <PolarisWordmark className="h-[26px] md:h-[30px] lg:h-[34px]" />
          </motion.span>
        </a>

        {/* Log in / Get the app / menu */}
        <div className="flex items-center gap-2" ref={menuRef}>
          <div className="relative flex items-center">
            <motion.div
              className="rv hidden h-[50px] items-center rounded-full bg-[rgba(20,17,12,0.42)] pl-[22px] pr-[2px] backdrop-blur-[14px] lg:flex"
              initial={{ clipPath: "inset(0% 0% 0% 100% round 999px)" }}
              animate={go ? { clipPath: "inset(0% 0% 0% 0% round 999px)" } : undefined}
              transition={{ delay: 0.55, duration: 0.75, ease: EASE_REVEAL }}
            >
              <motion.a
                href={nav.login.href}
                className="rv text-[17px] tracking-[-0.02em] text-white/95 transition-opacity hover:opacity-70"
                initial={{ x: 70, opacity: 0 }}
                animate={go ? { x: 0, opacity: 1 } : undefined}
                transition={{ delay: 0.6, duration: 0.75, ease: EASE_REVEAL }}
              >
                {nav.login.label}
              </motion.a>
              {/* Reserves the room "Get the app" sits in. */}
              <span aria-hidden="true" className="invisible ml-[14px] whitespace-nowrap px-[22px] text-[17px] tracking-[-0.02em]">
                {nav.cta.label}
              </span>
            </motion.div>
            <motion.a
              href={nav.cta.href}
              className="rv relative z-10 inline-flex h-[42px] items-center whitespace-nowrap rounded-full bg-white px-4 text-[15px] tracking-[-0.02em] text-olive transition-colors hover:bg-lime lg:absolute lg:inset-y-[2px] lg:right-[2px] lg:h-auto lg:px-[22px] lg:text-[17px]"
              initial={{ scale: 0.35, opacity: 0 }}
              animate={go ? { scale: 1, opacity: 1 } : undefined}
              transition={{ delay: 0.04, type: "spring", stiffness: 300, damping: 20 }}
            >
              {nav.cta.label}
            </motion.a>
          </div>

          <motion.button
            ref={buttonRef}
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="site-menu"
            onClick={() => setMenuOpen((v) => !v)}
            className="rv grid h-[42px] w-[42px] place-items-center rounded-full bg-[rgba(20,17,12,0.42)] text-white backdrop-blur-[14px] transition-colors hover:bg-[rgba(20,17,12,0.6)] lg:h-[50px] lg:w-[50px]"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={go ? { opacity: 1, scale: 1 } : undefined}
            transition={{ delay: 0.3, duration: 0.5, ease: EASE_REVEAL }}
          >
            <MenuIcon />
          </motion.button>

          <AnimatePresence>
            {menuOpen ? (
              <motion.div
                id="site-menu"
                className="absolute right-4 top-[68px] w-[240px] origin-top-right rounded-[22px] bg-white p-2 text-olive shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)] md:right-8 lg:right-12 lg:top-[116px]"
                initial={{ opacity: 0, scale: 0.94, y: -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -4 }}
                transition={{ duration: 0.25, ease: EASE_REVEAL }}
              >
                <ul ref={listRef}>
                  {[...nav.links, nav.login].map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        onClick={() => setMenuOpen(false)}
                        className="block rounded-[14px] px-4 py-3 text-[17px] tracking-[-0.02em] transition-colors hover:bg-pill"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </nav>
    </header>
  );
}

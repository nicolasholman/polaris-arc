"use client";

import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

import { CloseIcon } from "@/components/icons";
import { QuantityStepper } from "@/components/quantity";
import { FREE_SHIPPING_THRESHOLD } from "@/lib/catalog";
import { formatUsd } from "@/lib/money";
import { PolarisMessaging } from "@/lib/polaris-client";
import { pausedMessage } from "@/lib/polaris-config";
import { MAX_QUANTITY, useShop } from "@/lib/shop-context";

export function CartDrawer() {
  const { drawerOpen, closeDrawer, lines, subtotal, count, setQuantity, remove, polarisConfig } = useShop();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!drawerOpen) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    const t = window.setTimeout(() => closeRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
      if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])');
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
      window.clearTimeout(t);
      root.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
      returnFocus.current?.focus?.();
    };
  }, [drawerOpen, closeDrawer]);

  const toFree = FREE_SHIPPING_THRESHOLD - subtotal;

  return (
    <AnimatePresence>
      {drawerOpen ? (
        <div className="fixed inset-0 z-50">
          <motion.div
            className="absolute inset-0 bg-ink/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={closeDrawer}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bag-title"
            className="absolute inset-y-0 right-0 flex w-full max-w-[440px] flex-col bg-ground shadow-[-24px_0_60px_-30px_rgb(29_28_26/0.35)]"
            initial={reduce ? { opacity: 0 } : { x: "100%" }}
            animate={reduce ? { opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: "100%" }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="flex items-center justify-between px-5 pb-4 pt-5 sm:px-7">
              <h2 id="bag-title" className="display text-[1.9rem]">
                Your bag <span className="num text-muted">({count})</span>
              </h2>
              <button
                ref={closeRef}
                type="button"
                onClick={closeDrawer}
                className="-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-sand"
                aria-label="Close bag"
              >
                <CloseIcon size={22} />
              </button>
            </div>

            {lines.length === 0 ? (
              <div className="flex flex-1 flex-col items-start justify-center gap-5 px-5 pb-24 sm:px-7">
                <p className="display text-[2.2rem] leading-[1.05]">Nothing in here yet.</p>
                <p className="text-muted">Start with the things you&rsquo;d use every day.</p>
                <Link href="/shop" onClick={closeDrawer} className="btn btn-ink">
                  Shop the collection
                </Link>
              </div>
            ) : (
              <>
                <ul className="flex-1 divide-y divide-hair overflow-y-auto border-t border-hair px-5 sm:px-7">
                  {lines.map((line, i) => (
                    <motion.li
                      key={`${line.productId}:${line.optionId}`}
                      initial={reduce ? false : { opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.12 + i * 0.05, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                      className="flex gap-4 py-5"
                    >
                      <Link href={`/products/${line.product.slug}`} onClick={closeDrawer} className="tile relative h-[104px] w-[88px] shrink-0 overflow-hidden rounded-sm">
                        <Image src={line.product.image} alt={line.product.imageAlt} fill sizes="88px" className="object-cover" />
                      </Link>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium leading-snug">{line.product.name}</p>
                            <p className="text-[0.88rem] text-muted">
                              {line.product.optionLabel}: {line.option.label}
                            </p>
                          </div>
                          <p className="num shrink-0">{formatUsd(line.lineTotal)}</p>
                        </div>
                        <div className="mt-auto flex items-center justify-between pt-3">
                          <QuantityStepper
                            size="sm"
                            label="Quantity"
                            value={line.quantity}
                            max={MAX_QUANTITY}
                            onChange={(q) => setQuantity(line.productId, line.optionId, q)}
                          />
                          <button
                            type="button"
                            className="link -mx-2 inline-flex min-h-11 items-center px-2 text-[0.88rem] text-muted"
                            onClick={() => remove(line.productId, line.optionId)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </motion.li>
                  ))}
                </ul>
                <div className="border-t border-hair bg-paper px-5 pb-6 pt-5 sm:px-7">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[1.02rem]">Subtotal</span>
                    <span className="num text-[1.2rem] font-medium">{formatUsd(subtotal)}</span>
                  </div>
                  <p className="mt-1 text-[0.88rem] text-muted">
                    {toFree > 0 ? `${formatUsd(toFree)} away from free delivery.` : "Delivery is on us."}
                  </p>
                  {polarisConfig.ok ? (
                    <PolarisMessaging amount={(subtotal / 100).toFixed(2)} aprBps={polarisConfig.payInFourAprBps} paused={pausedMessage(polarisConfig.creditGuard)} className="mt-3 text-ink-2 [--polaris-message-size:0.9rem]" />
                  ) : null}
                  <div className="mt-5 grid gap-2.5">
                    <Link href="/checkout" onClick={closeDrawer} className="btn btn-ink w-full">
                      Check out
                    </Link>
                    <Link href="/cart" onClick={closeDrawer} className="btn btn-line w-full">
                      View bag
                    </Link>
                  </div>
                </div>
              </>
            )}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { CheckIcon } from "@/components/icons";
import { QuantityStepper } from "@/components/quantity";
import type { Product } from "@/lib/catalog";
import { formatUsd } from "@/lib/money";
import { payIn4 } from "@/lib/pay-in-4";
import { PolarisMark } from "@/lib/polaris-client";
import { pausedMessage } from "@/lib/polaris-config";
import { MAX_QUANTITY, useShop } from "@/lib/shop-context";

export function PurchasePanel({ product, aprBps }: { product: Product; aprBps: number }) {
  const { add, openDrawer, setBuyBar, polarisConfig } = useShop();
  const paused = polarisConfig.ok ? pausedMessage(polarisConfig.creditGuard) : null;
  const router = useRouter();
  const reduce = useReducedMotion();
  const groupId = useId();
  const [optionId, setOptionId] = useState(product.options[0]!.id);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const [barShown, setBarShown] = useState(false);
  const timers = useRef<number[]>([]);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  // On phones, a buy bar follows the page whenever the panel's own button is out of view, above or below.
  useEffect(() => {
    const button = buttonRef.current;
    if (!button || typeof IntersectionObserver === "undefined") return;
    const phone = window.matchMedia("(max-width: 1023px)");
    const observer = new IntersectionObserver(([entry]) => {
      const shown = phone.matches && !!entry && !entry.isIntersecting;
      setBarShown(shown);
      setBuyBar(shown);
    });
    observer.observe(button);
    return () => {
      observer.disconnect();
      setBuyBar(false);
    };
  }, [setBuyBar]);

  const subscription = Boolean(product.recurring);
  const optionLabel = product.options.find((o) => o.id === optionId)?.label;

  const onAdd = () => {
    if (subscription) {
      router.push(`/checkout?subscribe=${product.id}&option=${optionId}`);
      return;
    }
    add(product.id, optionId, quantity);
    setAdded(true);
    timers.current.push(window.setTimeout(openDrawer, reduce ? 0 : 520));
    timers.current.push(window.setTimeout(() => setAdded(false), 2200));
  };

  const many = product.options.length > 4;
  // While Polaris's risk guard has paused Pay in 4, the buy bar doesn't offer it.
  const plan = subscription || paused ? null : payIn4(product.price, aprBps);

  return (
    <div className="mt-8">
      <fieldset>
        <legend className="flex w-full items-baseline justify-between text-[0.92rem]">
          <span className="font-medium">{product.optionLabel}</span>
          <span className="text-muted">{optionLabel}</span>
        </legend>
        <div className={`mt-3 ${many ? "grid grid-cols-5 gap-2 sm:grid-cols-9" : "flex flex-wrap gap-2"}`}>
          {product.options.map((option) => {
            const checked = option.id === optionId;
            return (
              <label
                key={option.id}
                className={`relative inline-flex h-11 cursor-pointer items-center justify-center rounded-full px-4 text-[0.93rem] transition-[box-shadow,background-color] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sage ${
                  checked ? "bg-ink text-paper" : "shadow-[inset_0_0_0_1px_var(--color-hair-strong)] hover:shadow-[inset_0_0_0_1px_var(--color-ink)]"
                } ${many ? "px-0" : ""}`}
              >
                <input
                  type="radio"
                  name={groupId}
                  value={option.id}
                  checked={checked}
                  onChange={() => setOptionId(option.id)}
                  className="sr-only"
                />
                <span className="num">{option.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-6 flex gap-3">
        {subscription ? null : (
          <QuantityStepper label="Quantity" value={quantity} onChange={(q) => setQuantity(Math.max(1, Math.min(MAX_QUANTITY, q)))} max={MAX_QUANTITY} />
        )}
        <button ref={buttonRef} type="button" onClick={onAdd} className="btn btn-ink relative flex-1 overflow-hidden" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            {added ? (
              <motion.span
                key="added"
                className="inline-flex items-center gap-2"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -14 }}
                transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              >
                <CheckIcon size={18} /> Added to your bag
              </motion.span>
            ) : (
              <motion.span
                key="add"
                className="num inline-flex items-center gap-2"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -14 }}
                transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              >
                {subscription ? `Subscribe · ${formatUsd(product.price)} a month` : `Add to bag · ${formatUsd(product.price * quantity)}`}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>

      <AnimatePresence>
        {barShown ? (
          <motion.div
            key="buy-bar"
            initial={reduce ? { opacity: 0 } : { y: "100%" }}
            animate={reduce ? { opacity: 1 } : { y: 0 }}
            exit={reduce ? { opacity: 0 } : { y: "100%" }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-0 bottom-0 z-20 border-t border-hair bg-ground/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:hidden"
            role="region"
            aria-label={`Buy ${product.name}`}
          >
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="num text-[1.05rem] font-medium leading-tight">
                  {formatUsd(product.price)}
                  {subscription ? <span className="text-muted"> a month</span> : null}
                </p>
                {plan ? (
                  <p className="num flex items-center gap-1 truncate text-[0.82rem] text-muted">
                    or 4 × {formatUsd(plan.each)} with
                    <PolarisMark className="!inline-block !h-[0.9em] !w-[0.8em] ![filter:none]" /> Polaris
                  </p>
                ) : (
                  <p className="truncate text-[0.82rem] text-muted">{optionLabel}</p>
                )}
              </div>
              <button type="button" onClick={onAdd} className="btn btn-ink min-h-12 shrink-0 px-5">
                {added ? (
                  <>
                    <CheckIcon size={16} /> Added
                  </>
                ) : subscription ? (
                  "Subscribe"
                ) : (
                  "Add to bag"
                )}
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

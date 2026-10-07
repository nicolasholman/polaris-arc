"use client";

import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";

import type { Product } from "@/lib/catalog";

/** Close-ups taken from each photograph: where to look, and how near. */
const DETAILS: Record<string, { x: number; y: number; zoom: number; label: string }[]> = {
  "halcyon-one": [
    { x: 64, y: 66, zoom: 2.1, label: "Knit ear cushion" },
    { x: 44, y: 24, zoom: 2.2, label: "Headband" },
  ],
  "keys-75": [
    { x: 30, y: 34, zoom: 2.2, label: "Escape key" },
    { x: 60, y: 52, zoom: 2.2, label: "Keycaps" },
  ],
  "instant-camera": [
    { x: 58, y: 58, zoom: 2.2, label: "Lens" },
    { x: 38, y: 34, zoom: 2.2, label: "Flash and viewfinder" },
  ],
  "arc-lamp": [
    { x: 42, y: 26, zoom: 2.1, label: "Shade" },
    { x: 60, y: 80, zoom: 2.2, label: "Marble base" },
  ],
  "lounge-chair": [
    { x: 52, y: 52, zoom: 2.1, label: "Bouclé seat" },
    { x: 24, y: 62, zoom: 2.2, label: "Oak arm" },
  ],
  "pebble-speaker": [
    { x: 42, y: 56, zoom: 2.2, label: "Knit" },
    { x: 76, y: 32, zoom: 2.2, label: "Carry loop" },
  ],
  "court-sneakers": [
    { x: 42, y: 42, zoom: 2.2, label: "Heel tab" },
    { x: 64, y: 46, zoom: 2.2, label: "Laces" },
  ],
  "coffee-club": [
    { x: 62, y: 84, zoom: 2.2, label: "Beans" },
    { x: 78, y: 70, zoom: 2.2, label: "The cup" },
  ],
};

export function ProductGallery({ product }: { product: Product }) {
  const views = [{ x: 50, y: 50, zoom: 1.0, label: "The whole thing" }, ...(DETAILS[product.id] ?? [])];
  const [active, setActive] = useState(0);
  const reduce = useReducedMotion();
  const view = views[active]!;

  return (
    // At lg the details stand in a column beside the photograph, and the photograph fits the screen, so both show at 1440x900.
    <div className="lg:sticky lg:top-24 lg:grid lg:grid-cols-[88px_minmax(0,1fr)] lg:items-start lg:gap-4">
      <div className="tile relative aspect-square overflow-hidden lg:order-2 lg:aspect-auto lg:h-[min(calc(100svh-230px),780px)]">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={active}
            className="absolute inset-0"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <Image
              src={product.image}
              alt={active === 0 ? product.imageAlt : `${product.name}: ${view.label.toLowerCase()}, close up`}
              fill
              loading="eager"
              fetchPriority={active === 0 ? "high" : "auto"}
              // A close-up needs the full-resolution photograph.
              sizes={view.zoom > 1 ? "(min-width: 1024px) 100vw, 200vw" : "(min-width: 1024px) 58vw, 100vw"}
              className="object-cover"
              style={{ transform: `scale(${view.zoom})`, transformOrigin: `${view.x}% ${view.y}%` }}
            />
          </motion.div>
        </AnimatePresence>
        {active > 0 ? (
          <p className="absolute bottom-3 left-3 rounded-full bg-paper/85 px-3 py-1 text-[0.8rem] text-ink-2">Detail · {view.label}</p>
        ) : product.shownIn ? (
          <p className="absolute bottom-3 left-3 rounded-full bg-paper/85 px-3 py-1 text-[0.8rem] text-ink-2">Shown in {product.shownIn}</p>
        ) : null}
      </div>
      <div role="tablist" aria-label="Views" className="mt-3 grid grid-cols-3 gap-3 lg:order-1 lg:mt-0 lg:flex lg:flex-col">
        {views.map((v, i) => (
          <button key={v.label} type="button" role="tab" aria-selected={i === active} onClick={() => setActive(i)} className="group text-left">
            <span
              className={`tile relative block aspect-[4/3] overflow-hidden rounded-[2px] transition-opacity lg:aspect-square ${
                i === active ? "outline outline-[1.5px] outline-offset-[3px] outline-ink" : "opacity-75 group-hover:opacity-100"
              }`}
            >
              <Image
                src={product.image}
                alt=""
                fill
                sizes="(min-width: 1024px) 18vw, 30vw"
                className="pointer-events-none object-cover"
                style={{ transform: `scale(${v.zoom})`, transformOrigin: `${v.x}% ${v.y}%` }}
              />
            </span>
            {/* The close-ups are details of one photograph, and say so. */}
            <span className={`mt-1.5 block truncate text-[0.8rem] lg:sr-only ${i === active ? "text-ink" : "text-muted"}`}>{i === 0 ? "Whole view" : v.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

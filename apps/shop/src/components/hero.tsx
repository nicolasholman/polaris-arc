"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "motion/react";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The first viewport: a room in late-afternoon light with the collection in
 * it. The photograph opens from a narrow band, the way light comes through a
 * door, and the headline settles after it. The text rises with a CSS
 * animation (.hero-rise in globals.css), not a hydrated one, so it shows on
 * first paint and without JavaScript. Under reduced motion it simply appears.
 */
export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative">
      <div className="relative mx-auto max-w-[1440px] lg:px-10">
        <motion.div
          className="relative h-[46svh] min-h-[320px] overflow-hidden sm:h-[64svh] lg:h-[calc(100svh-150px)] lg:max-h-[860px] lg:min-h-[600px] lg:rounded-[3px]"
          initial={{ clipPath: "inset(18% 8% 18% 8%)" }}
          animate={{ clipPath: "inset(0% 0% 0% 0%)" }}
          transition={{ duration: 1.5, ease: EASE }}
        >
          <motion.div
            className="absolute inset-0"
            initial={{ scale: 1.12 }}
            animate={{ scale: 1 }}
            transition={{ duration: 2.2, ease: EASE }}
          >
            <Image
              src="/products/hero.jpg"
              alt="A sunlit corner with an oak lounge chair, Halcyon One headphones on the seat, and an Arc lamp and instant camera on a side table"
              fill
              preload
              sizes="(min-width: 1440px) 1360px, 100vw"
              className="object-cover object-[86%_50%] lg:object-center"
            />
          </motion.div>
        </motion.div>

        <div className="px-4 pt-6 sm:px-6 sm:pt-8 lg:absolute lg:inset-y-0 lg:left-10 lg:flex lg:w-[60%] lg:flex-col lg:justify-center lg:px-16 lg:pt-0 xl:w-[46%]">
          <h1
            id="hero-title"
            className="hero-rise display text-[2.9rem] leading-[0.98] [--rise-delay:0.35s] sm:text-[4.2rem] lg:text-[clamp(3.6rem,5.4vw,6rem)]"
          >
            Quiet things,
            <br />
            made to last.
          </h1>
          <p className="hero-rise mt-4 max-w-[26rem] text-[1.05rem] leading-relaxed text-ink-2 [--rise-delay:0.5s] sm:mt-5 lg:mt-6 lg:text-[1.15rem]">
            Headphones, lamps, chairs and the everyday objects around them, for slower days at home.
          </p>
          <div className="hero-rise mt-6 flex flex-wrap gap-3 [--rise-delay:0.6s] sm:mt-8">
            <Link href="/shop" className="btn btn-ink">
              Shop the collection
            </Link>
            <Link href="/products/halcyon-one" className="btn btn-line lg:bg-paper/40">
              Meet Halcyon One
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

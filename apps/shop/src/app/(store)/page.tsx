import Image from "next/image";
import Link from "next/link";

import { Hero } from "@/components/hero";
import { ArrowRightIcon, CheckIcon, ReturnIcon, TruckIcon } from "@/components/icons";
import { PayOverTimeBand } from "@/components/pay-over-time";
import { ProductCard } from "@/components/product-card";
import { ImageReveal } from "@/components/reveal";
import { CATEGORIES, getProduct, type Product } from "@/lib/catalog";
import { creditGuard, payInFourApr } from "@/lib/polaris";
import { pausedMessage } from "@/lib/polaris-config";

function product(id: string): Product {
  const p = getProduct(id);
  if (!p) throw new Error(`Unknown product ${id}`);
  return p;
}

export default async function HomePage() {
  const aprBps = payInFourApr();
  return (
    <>
      <Hero />

      <section aria-labelledby="edit-title" className="mx-auto max-w-[1440px] px-4 pt-24 sm:px-6 lg:px-10 lg:pt-36">
        <div className="flex items-end justify-between gap-6">
          <h2 id="edit-title" className="display text-[2.6rem] sm:text-[3.4rem] lg:text-[4rem]">
            The autumn edit
          </h2>
          <Link href="/shop" className="group mb-2 hidden items-center gap-2 text-[0.97rem] sm:inline-flex">
            <span className="link">Shop everything</span>
            <ArrowRightIcon size={18} className="transition-transform duration-300 group-hover:translate-x-1" />
          </Link>
        </div>
        <p className="mt-4 max-w-[34rem] text-[1.05rem] leading-relaxed text-muted">
          New headphones tuned for long evenings, a chair for the long read, and the small things that make a desk feel like yours.
        </p>

        <div className="mt-10 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:mt-14 lg:grid-cols-12 lg:gap-x-6 lg:gap-y-16">
          <ProductCard
            product={product("halcyon-one")}
            className="col-span-2 lg:col-span-7"
            aspect="aspect-[4/5] sm:aspect-square"
            sizes="(min-width: 1024px) 55vw, 100vw"
            priority
          />
          <ProductCard
            product={product("lounge-chair")}
            className="col-span-2 lg:col-span-5 lg:mt-[18%]"
            aspect="aspect-[4/5]"
            sizes="(min-width: 1024px) 40vw, 100vw"
            revealDelay={120}
          />
          <ProductCard product={product("instant-camera")} className="lg:col-span-4" sizes="(min-width: 1024px) 30vw, 50vw" />
          <ProductCard product={product("arc-lamp")} className="lg:col-span-4" sizes="(min-width: 1024px) 30vw, 50vw" revealDelay={90} />
          <ProductCard product={product("keys-75")} className="lg:col-span-4" sizes="(min-width: 1024px) 30vw, 50vw" revealDelay={180} />
          <ProductCard product={product("pebble-speaker")} className="lg:hidden" sizes="50vw" />
        </div>
      </section>

      <PayOverTimeBand aprBps={aprBps} example={product("halcyon-one")} paused={pausedMessage(await creditGuard())} />

      <section aria-labelledby="categories-title" className="mx-auto max-w-[1440px] px-4 pt-24 sm:px-6 lg:px-10 lg:pt-32">
        <h2 id="categories-title" className="display text-[2.6rem] sm:text-[3.4rem]">
          Shop by room
        </h2>
        <ul className="mt-10 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-4">
          {CATEGORIES.map((category, i) => (
            <li key={category.id}>
              <Link href={category.id === "coffee" ? "/products/coffee-club" : `/shop?category=${category.id}`} className="group block rounded-sm">
                <ImageReveal delay={i * 80}>
                  <div className="tile relative aspect-[3/4] overflow-hidden">
                    <div
                      className="absolute inset-0"
                      style={{ transform: `scale(${category.crop.zoom})`, transformOrigin: `${category.crop.x}% ${category.crop.y}%` }}
                    >
                      <Image
                        src={category.image}
                        alt=""
                        fill
                        sizes={category.crop.zoom > 1 ? "(min-width: 1024px) 50vw, 100vw" : "(min-width: 1024px) 25vw, 50vw"}
                        className="object-cover transition-transform duration-[1200ms] ease-[var(--ease-out-expo)] group-hover:scale-[1.035] motion-reduce:transition-none"
                        style={{ objectPosition: `${category.crop.x}% ${category.crop.y}%` }}
                      />
                    </div>
                  </div>
                </ImageReveal>
                <h3 className="display mt-4 flex items-center gap-2 text-[1.7rem]">
                  {category.name}
                  <ArrowRightIcon size={18} className="opacity-0 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100" />
                </h3>
                <p className="mt-1 text-[0.93rem] leading-snug text-muted">{category.blurb}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="club-title" className="mx-auto mt-24 max-w-[1440px] px-4 sm:px-6 lg:mt-32 lg:px-10">
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-20">
          <ImageReveal>
            <div className="tile relative aspect-[5/4] overflow-hidden">
              <Image src="/products/coffee.png" alt="A bag of Halcyon Coffee Club beans beside a cup of black coffee" fill sizes="(min-width: 1024px) 50vw, 100vw" className="object-cover" />
            </div>
          </ImageReveal>
          <div className="max-w-[30rem]">
            <h2 id="club-title" className="display text-[2.6rem] leading-[1.02] sm:text-[3.4rem]">
              A fresh bag, on the first week of every month.
            </h2>
            <p className="mt-6 text-[1.06rem] leading-relaxed text-ink-2">
              The Halcyon Coffee Club sends one single-origin coffee from a small roaster, roasted within a week of shipping, with a card on
              who grew it and how to brew it.
            </p>
            <p className="num mt-6 text-[1.15rem]">
              $18 <span className="text-muted">a month, delivery included</span>
            </p>
            <Link href="/products/coffee-club" className="btn btn-ink mt-8">
              Start your subscription
            </Link>
          </div>
        </div>
      </section>

      <section id="delivery" aria-label="Delivery and returns" className="mx-auto mt-24 max-w-[1440px] scroll-mt-24 px-4 sm:px-6 lg:mt-32 lg:px-10">
        <ul className="grid gap-8 border-t border-hair pt-10 sm:grid-cols-3">
          {[
            { icon: TruckIcon, title: "Free delivery over $150", body: "Everything else ships for $9. Chairs arrive assembled." },
            { icon: ReturnIcon, title: "30 days to change your mind", body: "Send it back unused within 30 days for a full refund." },
            { icon: CheckIcon, title: "Two years of cover", body: "If something we make stops working, we repair or replace it." },
          ].map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-4">
              <Icon size={22} className="mt-0.5 shrink-0 text-sage" />
              <div>
                <h3 className="font-medium">{title}</h3>
                <p className="mt-1 text-[0.94rem] leading-relaxed text-muted">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

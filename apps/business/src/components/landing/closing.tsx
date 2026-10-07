"use client";

import { Button } from "@polaris/ui";
import { ArrowRight, Store } from "lucide-react";
import Link from "next/link";

import { BusinessLogo } from "@/components/app/brand";
import { Glass } from "@/components/app/glass";
import { BlurWords, Rise } from "@/components/motion";
import { closing, hero } from "./content";
import { DemoShopButton } from "./demo-shop";
import { Shell } from "./section";

/** The closing call to action: the lime glass card and one more "Start". */
export function Closing() {
  return (
    <section aria-labelledby="closing-title" className="py-20 lg:py-28">
      <Shell>
        <div className="relative isolate overflow-hidden rounded-[32px] bg-ui-frame px-6 py-14 text-[#121418] sm:px-12 lg:px-16 lg:py-20">
          <Glass
            art="card-lime"
            size={420}
            eager
            className="float-slow absolute -right-16 -bottom-24 -z-10 w-[260px] rotate-[-12deg] opacity-95 sm:w-[340px] lg:top-1/2 lg:right-12 lg:bottom-auto lg:w-[400px] lg:-translate-y-1/2"
          />
          <BlurWords
            id="closing-title"
            as="h2"
            text={closing.heading}
            className="max-w-[12ch] text-[clamp(40px,6vw,88px)] leading-[0.98] font-medium tracking-[-0.05em]"
          />
          <Rise y={14} delay={0.3}>
            <p className="mt-5 max-w-[440px] text-[17px] leading-[1.5] text-black/70 lg:text-[19px]">{closing.sub}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild variant="dark" size="lg" iconRight={<ArrowRight />} className="bg-[#0f1011] text-white">
                <Link href="/login">{hero.primary}</Link>
              </Button>
              <DemoShopButton icon={<Store />} variant="white" size="lg" label={hero.secondary} />
            </div>
          </Rise>
        </div>
      </Shell>
    </section>
  );
}

/** The footer: the wordmark, where to go, and what it's built on. */
export function Footer() {
  return (
    <footer className="border-t border-ui-hairline py-12">
      <Shell className="grid gap-10 md:grid-cols-[minmax(0,1.2fr)_repeat(2,minmax(0,0.6fr))]">
        <div className="grid content-start gap-4">
          <BusinessLogo height={30} />
          <p className="max-w-[40ch] text-[14px] leading-relaxed text-ui-muted">
            Payment links with credit built in: Stripe for every app on Monad. Built for Monad Metropolis 2026.
          </p>
        </div>
        <nav aria-label="Product" className="grid content-start gap-2 text-[15px]">
          <p className="mb-1 text-[13px] font-medium text-ui-muted uppercase">Product</p>
          <a className="text-ui-muted hover:text-ui-text" href="#ways">Checkout</a>
          <a className="text-ui-muted hover:text-ui-text" href="#credit">Pay in 4</a>
          <a className="text-ui-muted hover:text-ui-text" href="#payouts">Payouts</a>
          <a className="text-ui-muted hover:text-ui-text" href="#pricing">Pricing</a>
        </nav>
        <nav aria-label="Account" className="grid content-start gap-2 text-[15px]">
          <p className="mb-1 text-[13px] font-medium text-ui-muted uppercase">Merchants</p>
          <Link className="text-ui-muted hover:text-ui-text" href="/login">Sign in</Link>
          <Link className="text-ui-muted hover:text-ui-text" href="/dashboard">Dashboard</Link>
          <a className="text-ui-muted hover:text-ui-text" href="#developers">Developers</a>
          <a className="text-ui-muted hover:text-ui-text" href="#faq">FAQ</a>
        </nav>
      </Shell>
      <Shell className="mt-10 flex flex-wrap items-center justify-between gap-3 text-[13px] text-ui-muted">
        <p>© 2026 Polaris. Test mode: no real money moves.</p>
        <p>Monad · Privy · Chainlink CRE · Nansen · Envio · Agora AUSD · Mera</p>
      </Shell>
    </footer>
  );
}

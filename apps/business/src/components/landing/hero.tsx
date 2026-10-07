"use client";

import { PrimaryButton, SecondaryButton, StatusPill } from "@polaris/ui";
import { ArrowRight, Check, Store } from "lucide-react";
import Link from "next/link";

import { BlurWords, Rise } from "@/components/motion";
import { useDemoShopUrl } from "@/lib/demo-shop";
import { DEMO_SHOP_SOON } from "@/lib/features";
import { hero } from "./content";
import { networkLabel, useNetworkName } from "./nav";
import { ProductPreview } from "./preview";

/**
 * The hero, in ref E's language: the headline over the product itself, the
 * reference's chart panel beside its stacked-card widget, live and
 * interactive with an invented studio's numbers.
 */
export function Hero() {
  const DEMO_SHOP_URL = useDemoShopUrl();
  const network = useNetworkName();
  return (
    <section aria-labelledby="hero-title" className="relative isolate pt-4 pb-16 sm:pt-6 lg:pb-24">
      <div className="mx-auto flex max-w-[1280px] flex-col items-center px-4 text-center sm:px-6 lg:px-8">
        {/* From lg the nav already carries the network pill. */}
        <Rise y={10} blur={6} duration={0.7} className="lg:hidden">
          <StatusPill tone="lime" size="md" icon={<span className="block size-2 rounded-full bg-current" />}>
            {network === undefined ? hero.eyebrow : `${hero.eyebrow} · ${network ? `running on ${networkLabel(network)}` : networkLabel(network)}`}
          </StatusPill>
        </Rise>

        <h1
          id="hero-title"
          aria-label={hero.headline.join(" ")}
          className="mt-6 text-[clamp(44px,5vw,72px)] lg:mt-2 leading-[0.98] font-medium tracking-[-0.05em] text-balance"
        >
          <BlurWords as="span" css text={hero.headline[0]!} className="block" lineClassName="block" delay={0.05} />
          <BlurWords as="span" css text={hero.headline[1]!} className="block text-ui-lime-active" lineClassName="block" delay={0.3} />
        </h1>

        <Rise y={16} blur={8} delay={0.45} duration={0.8}>
          <p className="mt-5 max-w-[620px] text-[17px] leading-[1.5] text-ui-muted sm:text-[19px]">{hero.sub}</p>
        </Rise>

        <Rise y={16} delay={0.6} duration={0.8} className="mt-7 flex flex-wrap justify-center gap-3">
          <PrimaryButton asChild size="lg" iconRight={<ArrowRight />}>
            <Link href="/login">{hero.primary}</Link>
          </PrimaryButton>
          {DEMO_SHOP_URL ? (
            <SecondaryButton asChild size="lg" icon={<Store />}>
              <a href={DEMO_SHOP_URL} target="_blank" rel="noreferrer">
                {hero.secondary}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </SecondaryButton>
          ) : (
            <SecondaryButton size="lg" icon={<Store />} disabled>
              {DEMO_SHOP_SOON}
            </SecondaryButton>
          )}
        </Rise>

      </div>

      {/* The product, close under the buttons so its chart shows on the first
          screen; tall, so it reveals as soon as its top edge shows. */}
      <Rise y={48} blur={10} delay={0.55} duration={1.1} amount={0.04} className="mx-auto mt-9 max-w-[1280px] lg:mt-7 px-4 sm:px-6 lg:px-8">
        <ProductPreview />
        <p className="mt-4 text-center text-[13px] text-ui-muted">A live preview with an invented studio. Switch the payment mode and pay as the buyer.</p>
        <ul className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[14px] text-ui-muted">
          {hero.trust.map((t) => (
            <li key={t} className="inline-flex items-center gap-2">
              <Check aria-hidden size={15} strokeWidth={2.25} className="text-ui-lime-text" />
              {t}
            </li>
          ))}
        </ul>
      </Rise>
    </section>
  );
}

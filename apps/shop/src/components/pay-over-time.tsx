import Image from "next/image";
import Link from "next/link";

import { ImageReveal } from "@/components/reveal";
import type { Product } from "@/lib/catalog";
import { formatUsd } from "@/lib/money";
import { aprLabel, payIn4, weekLabel } from "@/lib/pay-in-4";
import { PolarisLockup } from "@/components/polaris-lockup";
import { PolarisMark } from "@/lib/polaris-client";

/** The store's "Pay over time with Polaris" band, as a store would run a BNPL provider's promotion. */
export function PayOverTimeBand({ aprBps, example, paused = null }: { aprBps: number; example: Product; paused?: string | null }) {
  const plan = payIn4(example.price, aprBps)!;
  const facts = [
    { title: `4 payments, ${aprLabel(plan.aprBps)}`, body: `${formatUsd(plan.interest)} of interest on this example, shown before you confirm.` },
    { title: "An instant decision", body: "Polaris answers at checkout, with the reasons for your limit." },
    { title: "Paid automatically", body: "Each payment is collected weekly. Miss one and your limit and collateral are at stake." },
  ];

  return (
    <section id="pay-over-time" aria-labelledby="pot-title" className="mt-24 scroll-mt-20 bg-sand lg:mt-36">
      <div className="mx-auto grid max-w-[1440px] gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-20 lg:px-10 lg:py-28">
        <div>
          <h2 id="pot-title" className="display text-[2.6rem] leading-[1.02] sm:text-[3.4rem] lg:text-[4rem]">
            Pay over time
            <br />
            with{" "}
            <span className="whitespace-nowrap">
              <PolarisMark className="!inline-block !h-[0.78em] !w-[0.7em] align-[-0.02em] ![filter:none]" /> Polaris.
            </span>
          </h2>
          <p className="mt-6 max-w-[31rem] text-[1.06rem] leading-relaxed text-ink-2">
            Choose Polaris at checkout and split your order into four weekly payments, the first a week from today. Nothing to pay at
            checkout. Confirm with Face ID; there is no card to type in.
          </p>
          {paused ? (
            <p role="status" className="mt-5 max-w-[31rem] rounded-xl bg-paper px-4 py-3 text-[0.95rem] leading-relaxed text-ink shadow-[inset_0_0_0_1px_var(--color-hair-strong)]">
              {paused}
            </p>
          ) : null}
          <dl className="mt-10 max-w-[34rem] divide-y divide-hair-strong border-y border-hair-strong">
            {facts.map((fact) => (
              <div key={fact.title} className="grid gap-1 py-4 sm:grid-cols-[14rem_1fr] sm:gap-6">
                <dt className="font-medium">{fact.title}</dt>
                <dd className="text-[0.95rem] text-muted">{fact.body}</dd>
              </div>
            ))}
          </dl>
        </div>

        <ImageReveal>
          <figure className="rounded-[22px] bg-[#111210] p-6 text-[#f5f5f5] shadow-[0_40px_80px_-40px_rgb(29_28_26/0.55)] sm:p-9">
            <div className="flex items-center justify-between">
              <PolarisLockup className="text-[1.05rem]" />
              <span className="text-[0.82rem] text-white/55">Pay in 4</span>
            </div>
            <div className="mt-8 flex items-center gap-4">
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[#f2eee7]">
                <Image src={example.image} alt="" fill sizes="64px" className="object-cover" />
              </div>
              <div className="min-w-0">
                <p className="font-medium">{example.name}</p>
                <p className="num text-[0.92rem] text-white/60">
                  Halcyon is paid {formatUsd(example.price)} today. You pay Polaris over 4 weeks.
                </p>
              </div>
            </div>
            <p className="num mt-8 text-[2.6rem] font-semibold leading-none tracking-[-0.03em] sm:text-[3.2rem]">4 × {formatUsd(plan.each)}</p>
            <p className="num mt-3 text-[0.9rem] text-white/60">Nothing today. The first payment is a week after you order.</p>
            <ol className="mt-7 grid grid-cols-4 gap-2 sm:gap-3" aria-label="Payment schedule">
              {plan.installments.map((inst) => (
                <li key={inst.index} className="grid gap-2 text-[0.8rem] text-white/60 sm:text-[0.86rem]">
                  <span className="h-1.5 rounded-full bg-white/15" />
                  <span className="num text-[0.92rem] font-medium text-white sm:text-[1rem]">{formatUsd(inst.amount)}</span>
                  {weekLabel(inst.dueInSeconds) ?? `Payment ${inst.index}`}
                </li>
              ))}
            </ol>
            <figcaption className="mt-8 border-t border-white/10 pt-5 text-[0.86rem] leading-relaxed text-white/60">
              {`${formatUsd(plan.total)} in total, including ${formatUsd(plan.interest)} interest at ${aprLabel(plan.aprBps)}. `}
              <Link href={`/products/${example.slug}`} className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">
                {example.id === "halcyon-one" ? "See the headphones" : `See the ${example.name}`}
              </Link>
            </figcaption>
          </figure>
        </ImageReveal>
      </div>
    </section>
  );
}

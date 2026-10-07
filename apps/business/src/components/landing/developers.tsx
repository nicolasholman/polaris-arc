"use client";

import { CodeBlock } from "@polaris/ui";
import { Check } from "lucide-react";

import { Rise } from "@/components/motion";
import { developers } from "./content";
import { SectionIntro, Shell } from "./section";

/**
 * "A few lines of code": polarispay-sdk 0.3.0 as it ships (createPolarisServer,
 * checkout.sessions.create, webhooks.verify, the React button) in React,
 * Node and HTML, against this server's checkout-session API.
 */
export function Developers() {
  return (
    <section id="developers" aria-labelledby="dev-title" className="scroll-mt-24 py-20 lg:py-28">
      <Shell className="grid items-center gap-12 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] xl:gap-16">
        <div>
          <SectionIntro id="dev-title" eyebrow={developers.eyebrow} heading={developers.heading} sub={developers.sub} />
          <ul className="mt-8 grid gap-3">
            {developers.bullets.map((b, i) => (
              <Rise as="li" key={b} y={12} delay={0.2 + i * 0.08} className="flex items-center gap-3 text-[16px]">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ui-surface-2 text-ui-lime">
                  <Check size={15} strokeWidth={2.25} aria-hidden />
                </span>
                {b}
              </Rise>
            ))}
          </ul>
        </div>
        <Rise y={32} blur={8} duration={0.9} delay={0.15} className="min-w-0">
          <CodeBlock
            aria-label="SDK example"
            note={developers.note}
            copyable
            defaultKey="node"
            samples={developers.samples.map((s) => ({ ...s }))}
            className="shadow-[0_40px_100px_-40px_rgb(0_0_0/0.9)]"
          />
        </Rise>
      </Shell>
    </section>
  );
}

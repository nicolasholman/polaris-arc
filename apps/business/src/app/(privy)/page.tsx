import type { Metadata } from "next";

import { Closing, Footer } from "@/components/landing/closing";
import { Credit } from "@/components/landing/credit";
import { Developers } from "@/components/landing/developers";
import { Faq } from "@/components/landing/faq";
import { LandingFrame } from "@/components/landing/frame";
import { Hero } from "@/components/landing/hero";
import { LandingNav } from "@/components/landing/nav";
import { Payouts } from "@/components/landing/payouts";
import { Pricing } from "@/components/landing/pricing";
import { Sponsors } from "@/components/landing/sponsors";
import { Ways } from "@/components/landing/ways";
import { SmoothScroll } from "@/components/motion";

export const metadata: Metadata = {
  title: { absolute: "Polaris for Business: get paid in full, let them pay in 4" },
  description:
    "One payment link: your buyer pays now, in four payments on Polaris credit, or by subscription. You're paid in full, in dollars, in 0.8 seconds. 0.5% per payment.",
};

/** The merchant landing, for signed-out visitors (signed-in ones see "Open dashboard"). */
export default function LandingPage() {
  return (
    <SmoothScroll>
      <LandingFrame className="overflow-hidden">
        <LandingNav />
        <main>
          <Hero />
          <Sponsors />
          <Ways />
          <Credit />
          <Developers />
          <Payouts />
          <Pricing />
          <Faq />
          <Closing />
        </main>
        <Footer />
      </LandingFrame>
    </SmoothScroll>
  );
}

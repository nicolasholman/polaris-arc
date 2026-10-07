import type { Metadata } from "next";
import { Suspense } from "react";
import { preload } from "react-dom";
import { Adaptive } from "@polaris/ui";
import { OnboardingDesktop } from "@/desktop/onboarding";
import { Onboarding } from "@/screens/onboarding";

export const metadata: Metadata = { title: "Welcome" };

export default function OnboardPage() {
  // The first page's animation starts downloading with the page, not after it.
  preload("/lottie/onboarding-1.json", { as: "fetch", crossOrigin: "anonymous" });
  return (
    <Suspense>
      {/* The phone's three pages below 1024px; the framed sign-up beside the art from 1024px. */}
      <Adaptive phone={<Onboarding />} desktop={<OnboardingDesktop />} />
    </Suspense>
  );
}

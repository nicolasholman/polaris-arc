"use client";

import { useAdaptive, useIsDesktop } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";
import { PlansDesktop } from "@/desktop/plans";
import { Insights } from "./insights";

/**
 * /plans: Pay in 4's own page from 1024px. On a phone, plans live under
 * Insights (Expenses | Plans), so it goes there.
 */
export function PlansPage() {
  const { mode, settled } = useAdaptive();
  const router = useRouter();
  useEffect(() => {
    if (settled && mode === "phone") router.replace("/insights?view=plans");
  }, [settled, mode, router]);
  return mode === "desktop" ? <PlansDesktop /> : null;
}

/** What a plan's details open over, cold: the Plans view on a phone, the Pay in 4 page on a desktop. */
export function PlansBehind() {
  return useIsDesktop() ? (
    <PlansDesktop />
  ) : (
    <Suspense>
      <Insights />
    </Suspense>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { Insights } from "@/screens/insights";

export const metadata: Metadata = { title: "Insights" };

export default function InsightsPage() {
  return (
    <Suspense>
      <Insights />
    </Suspense>
  );
}

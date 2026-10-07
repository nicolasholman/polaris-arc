import type { Metadata } from "next";
import { Suspense } from "react";

import { PlansView } from "./plans-view";

export const metadata: Metadata = { title: "Pay in 4" };

export default function PlansPage() {
  return (
    <Suspense fallback={null}>
      <PlansView />
    </Suspense>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";

import { LinksView } from "./links-view";

export const metadata: Metadata = { title: "Payment links" };

export default function LinksPage() {
  return (
    <Suspense fallback={null}>
      <LinksView />
    </Suspense>
  );
}

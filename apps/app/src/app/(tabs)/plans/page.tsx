import type { Metadata } from "next";
import { PlansPage } from "@/screens/plans-page";

export const metadata: Metadata = { title: "Pay in 4" };

/** Pay in 4's page on a desktop; a phone keeps plans under Insights. */
export default function Page() {
  return <PlansPage />;
}

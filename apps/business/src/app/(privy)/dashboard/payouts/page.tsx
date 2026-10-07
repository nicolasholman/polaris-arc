import type { Metadata } from "next";

import { PayoutsView } from "./payouts-view";

export const metadata: Metadata = { title: "Payouts" };

export default function PayoutsPage() {
  return <PayoutsView />;
}

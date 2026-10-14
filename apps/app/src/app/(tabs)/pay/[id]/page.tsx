import type { Metadata } from "next";
import { PayLinkClient } from "./pay-link-client";

type Props = { params: Promise<{ id: string }> };

// Metadata must not open a buyer's checkout session on the server. The
// browser owns the session and can retry a temporary API outage in place.
export const metadata: Metadata = { title: "Pay with Polaris" };

export default async function PayLinkPage({ params }: Props) {
  const { id } = await params;
  return <PayLinkClient id={id} />;
}

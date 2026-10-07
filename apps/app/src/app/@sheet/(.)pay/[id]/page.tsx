import { lookupPaymentLink } from "@/lib/data";
import { CheckoutRoute } from "@/sheets/checkout";

type Props = { params: Promise<{ id: string }> };

/** A payment link opened from inside the app (Pay, a pasted or scanned link): checkout over the current tab. */
export default async function Page({ params }: Props) {
  const { id } = await params;
  const { link, gone } = await lookupPaymentLink(id);
  return <CheckoutRoute link={link} gone={gone} />;
}

import type { Metadata } from "next";
import { lookupPaymentLink } from "@/lib/data";
import { Home } from "@/screens/home";
import { CheckoutRoute } from "@/sheets/checkout";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const { link } = await lookupPaymentLink(id);
  return { title: link ? `Pay ${link.merchant.name}` : "Payment link" };
}

/** A merchant's payment link, opened cold: checkout over a blurred Home. */
export default async function PayLinkPage({ params }: Props) {
  const { id } = await params;
  const { link, gone } = await lookupPaymentLink(id);
  return (
    <>
      <Home />
      <CheckoutRoute link={link} gone={gone} cold />
    </>
  );
}

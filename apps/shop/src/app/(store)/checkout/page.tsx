import type { Metadata } from "next";

import { CheckoutView } from "@/components/checkout/checkout-view";
import { getOption, getProduct } from "@/lib/catalog";

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ subscribe?: string; option?: string; canceled?: string }>;
}) {
  const params = await searchParams;
  const product = params.subscribe ? getProduct(params.subscribe) : undefined;
  const subscription =
    product?.recurring && params.option && getOption(product, params.option)
      ? { productId: product.id, optionId: params.option }
      : product?.recurring
        ? { productId: product.id, optionId: product.options[0]!.id }
        : null;

  // Keyed, so moving between the bag and a subscription starts a fresh checkout.
  return <CheckoutView key={subscription?.productId ?? "bag"} subscription={subscription} returnedFromCancel={params.canceled === "1"} />;
}

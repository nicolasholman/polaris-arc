import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { OrderView } from "@/components/order/order-view";
import { accessCookieName, canRead, orderForBrowser } from "@/lib/orders/access";
import { getOrder } from "@/lib/orders/service";
import { browserConfig } from "@/lib/polaris";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your order", robots: { index: false } };

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ via?: string }> }) {
  const [{ id }, { via }] = await Promise.all([params, searchParams]);
  const order = await getOrder(id);
  if (!order) notFound();
  // The buyer's details only for the browser that placed the order.
  const readable = canRead(order, (await cookies()).get(accessCookieName(id))?.value);
  const config = browserConfig();
  return (
    <OrderView
      initial={orderForBrowser(order, readable)}
      fromPolaris={via === "polaris"}
      fromCheckout={via === "polaris" || via === "wallet"}
      checkoutOrigin={config.ok ? config.checkoutOrigin : null}
    />
  );
}

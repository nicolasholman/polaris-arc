import { connection } from "next/server";
import type { ReactNode } from "react";

import { CartDrawer } from "@/components/cart-drawer";
import { DevDrawer } from "@/components/dev-drawer";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { browserConfig, creditGuard } from "@/lib/polaris";
import { ShopProvider } from "@/lib/shop-context";

export default async function StoreLayout({ children }: { children: ReactNode }) {
  // The Polaris settings (publishable key, checkout origin, relay, APR) are
  // read when a page is served, never baked in when the store is built: a
  // build made without keys, or with other keys, must not stick to them.
  await connection();
  const config = browserConfig();
  // Polaris's risk guard as the page is served: while it has paused credit, Pay in 4 is off everywhere.
  const polaris = config.ok ? { ...config, creditGuard: await creditGuard() } : config;
  return (
    <ShopProvider polarisConfig={polaris}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>
      <div className="bg-sand/70 text-center text-[0.82rem] text-ink-2">
        <p className="mx-auto max-w-[1440px] px-4 py-2">Free delivery over $150, and 30 days to change your mind.</p>
      </div>
      <Header />
      <main id="main">{children}</main>
      <Footer />
      <CartDrawer />
      <DevDrawer />
    </ShopProvider>
  );
}

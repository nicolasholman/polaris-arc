"use client";

import { useEffect, useState } from "react";

import { DEMO_SHOP_URL } from "./features";

let probe: Promise<boolean> | null = null;

/** One no-cors HEAD per page load: resolves when anything answers, rejects on a refused connection. */
function shopAnswers(url: string): Promise<boolean> {
  probe ??= fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store" }).then(
    () => true,
    () => false,
  );
  return probe;
}

/**
 * The demo shop's URL, or null while there's no shop to open. In development
 * the local shop is checked first, so when it isn't running every demo-shop
 * control reads "Demo shop coming soon" instead of opening a refused
 * connection. A production build trusts NEXT_PUBLIC_DEMO_SHOP_URL.
 */
export function useDemoShopUrl(): string | null {
  const [url, setUrl] = useState<string | null>(DEMO_SHOP_URL);
  useEffect(() => {
    if (!DEMO_SHOP_URL || process.env.NODE_ENV !== "development") return;
    let live = true;
    void shopAnswers(DEMO_SHOP_URL).then((ok) => {
      if (live) setUrl(ok ? DEMO_SHOP_URL : null);
    });
    return () => {
      live = false;
    };
  }, []);
  return url;
}

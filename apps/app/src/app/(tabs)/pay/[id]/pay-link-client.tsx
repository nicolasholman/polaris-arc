"use client";

import { useIsDesktop } from "@polaris/ui";
import { CheckoutDesktop, CheckoutMissing } from "@/desktop/checkout";
import { useEffect, useState } from "react";
import { CouldNotReach } from "@/components/reach-error";
import { lookupPaymentLink, type LinkLookup } from "@/lib/data";
import { Home } from "@/screens/home";
import { CheckoutClosed, CheckoutRoute } from "@/sheets/checkout";

export function PayLinkClient({ id }: { id: string }) {
  const desktop = useIsDesktop();
  const [lookup, setLookup] = useState<LinkLookup | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    lookupPaymentLink(id).then(
      (value) => { if (current) setLookup(value); },
      (cause: unknown) => { if (current) setError(cause instanceof Error ? cause : new Error("Checkout unavailable")); },
    );
    return () => { current = false; };
  }, [id, attempt]);
  if (error) return <CouldNotReach error={error} reset={() => { setError(null); setAttempt(n => n + 1); }} />;
  if (desktop && lookup) return !lookup.link ? <CheckoutMissing gone={lookup.gone} /> : lookup.link.status !== "open" ? <CheckoutClosed link={lookup.link} framed /> : <CheckoutDesktop link={lookup.link} />;
  return <>
    <Home />
    {lookup ? <CheckoutRoute link={lookup.link} gone={lookup.gone} cold /> :
      <div role="status" className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm">Opening checkout…</div>}
  </>;
}

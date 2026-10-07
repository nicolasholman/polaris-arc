"use client";

import { CouldNotReach } from "@/components/reach-error";

/** A payment link whose session couldn't be opened or read (the API was slow or down): Try again opens it again. */
export default function PayLinkError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <CouldNotReach error={error} reset={reset} />;
}

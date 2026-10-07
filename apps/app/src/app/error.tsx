"use client";

import { CouldNotReach } from "@/components/reach-error";

/** Any page whose server read failed: say so, and offer Try again. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="flex min-h-dvh items-center">
      <CouldNotReach error={error} reset={reset} />
    </main>
  );
}

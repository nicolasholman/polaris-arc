"use client";

import { Button, EmptyState } from "@polaris/ui";
import { CloudOff } from "lucide-react";
import { useEffect } from "react";

/**
 * What a page shows when a server read failed (Polaris for Business was
 * slow or down): the reason in the buyer's words, and Try again, which
 * re-renders the page (Next's error boundary `reset`). Nothing was charged:
 * reads never move money.
 */
export function CouldNotReach({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto grid min-h-[60dvh] w-full max-w-[440px] place-items-center px-5">
      <EmptyState
        icon={<CloudOff />}
        title="We couldn't reach Polaris"
        description="Nothing was charged. Check your connection, then try again."
        action={
          <Button variant="white" size="lg" shape="rounded" onClick={() => reset()}>
            Try again
          </Button>
        }
      />
    </div>
  );
}

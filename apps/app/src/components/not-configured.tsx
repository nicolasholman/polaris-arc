"use client";

import { Adaptive, AppFrame, IconDisc, IconProvider, Logo } from "@polaris/ui";
import { Unplug } from "lucide-react";

const TITLE = "Polaris isn't configured on this build";
const BODY =
  "This copy of the app isn't connected to Polaris for Business, so it has no accounts, balances or payment links to show, and it can't sign anything.";

/** For whoever deployed it: the one setting that's missing. */
function OperatorNote({ className }: { className?: string }) {
  return (
    <p className={className}>
      To fix it, set <code className="rounded-[6px] bg-ui-surface-2 px-1.5 py-0.5 font-mono text-[0.9em] text-ui-text">NEXT_PUBLIC_POLARIS_API_URL</code>{" "}
      and rebuild.
    </p>
  );
}

/**
 * The whole app when `NEXT_PUBLIC_POLARIS_API_URL` is unset: no data, no
 * account, nothing to sign. It stands in for every route (the Providers
 * render it instead of the app). On a phone, the message in the middle of
 * the dark screen under the wordmark; from 1024px, in ref E's frame like the
 * 404: the panel on the lime canvas, the wordmark, a lime icon well.
 */
export function NotConfigured() {
  return (
    <IconProvider>
      <Adaptive
        phone={
          <main id="main" className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-5 pt-[max(24px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
            <Logo height={26} />
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center font-satoshi">
              <IconDisc icon={<Unplug />} className="mb-1" />
              <h1 className="text-[22px] leading-tight font-medium tracking-[-0.02em]">{TITLE}</h1>
              <p className="max-w-[36ch] text-[15px] leading-[1.45] text-ui-muted">{BODY}</p>
              <OperatorNote className="mt-3 max-w-[36ch] text-[13px] leading-[1.6] text-ui-muted" />
            </div>
          </main>
        }
        desktop={
          <AppFrame panelClassName="flex flex-col">
            <header className="flex h-[104px] items-center px-10 xl:h-[112px] xl:px-14">
              <Logo height={30} />
            </header>
            <main id="main" className="grid flex-1 place-items-center px-10 pb-20">
              <div className="grid max-w-[520px] justify-items-center gap-6 text-center">
                <IconDisc icon={<Unplug />} className="bg-ui-lime-button text-ui-on-lime" />
                <div className="grid gap-2">
                  <h1 className="text-[28px] leading-tight font-medium tracking-[-0.03em]">{TITLE}</h1>
                  <p className="text-[16px] leading-relaxed text-ui-muted">{BODY}</p>
                </div>
                <OperatorNote className="text-[14px] leading-relaxed text-ui-muted" />
              </div>
            </main>
          </AppFrame>
        }
      />
    </IconProvider>
  );
}

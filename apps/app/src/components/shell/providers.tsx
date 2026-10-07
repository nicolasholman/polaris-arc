"use client";

import { IconProvider, SheetStage, Toaster } from "@polaris/ui";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AccountProviders } from "@/lib/account/privy-bridge";
import { apiConfigured } from "@/lib/api";
import { NotConfigured } from "../not-configured";
import { EmailLoginSheet } from "../email-login-sheet";
import { BuildBadges } from "./chrome";
import { SheetHost } from "./sheet-host";

/**
 * The app frame. The stage is exactly the viewport and the page scrolls
 * inside it, so when a sheet pushes the stage back (scaled to 0.96 with
 * rounded corners, like iOS) the floating nav goes back with it. From 1024px
 * the same scroller holds the desktop layout (ref E's frame, the tabs layout).
 * A build without `NEXT_PUBLIC_POLARIS_API_URL` renders only `NotConfigured`.
 */
export function Providers({ children, sheet }: { children: ReactNode; sheet: ReactNode }) {
  const pathname = usePathname() ?? "/";
  // The component gallery (development builds only) is self-contained: its own stage, no account.
  if (process.env.NODE_ENV !== "production" && pathname.startsWith("/gallery")) return <>{children}</>;
  // No Polaris for Business: no data and nothing to sign, on every route.
  if (!apiConfigured()) return <NotConfigured />;
  return (
    <IconProvider>
      <AccountProviders>
        <SheetStage className="h-dvh overflow-hidden">
          <SheetHost>
            <div id="scroller" className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain">
              {children}
            </div>
            {sheet}
            <EmailLoginSheet />
          </SheetHost>
        </SheetStage>
        <BuildBadges />
        <Toaster />
      </AccountProviders>
    </IconProvider>
  );
}

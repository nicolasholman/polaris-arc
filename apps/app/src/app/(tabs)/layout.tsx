import { Adaptive } from "@polaris/ui";
import type { ReactNode } from "react";
import { DesktopShell } from "@/components/shell/desktop-shell";
import { FirstRun } from "@/components/shell/first-run";
import { TabBar } from "@/components/shell/tab-bar";

/**
 * The five tabs: full screens under the floating nav. Everything else is a
 * sheet over them. From 1024px the same pages sit in ref E's frame under a
 * top nav instead (each screen renders its desktop layout there).
 */
export default function TabsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Adaptive
        phone={
          <>
            {children}
            <TabBar />
          </>
        }
        desktop={<DesktopShell>{children}</DesktopShell>}
      />
      <FirstRun />
    </>
  );
}

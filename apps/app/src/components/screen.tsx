import { cn } from "@polaris/ui";
import type { ReactNode } from "react";

/**
 * A tab's page: the phone column, clear of the status bar at the top and of
 * the floating nav at the bottom. `tight` is ref A's Home gutter (12px);
 * the other tabs use 20px.
 */
export function TabScreen({
  children,
  gutter = "md",
  className,
}: {
  children: ReactNode;
  gutter?: "tight" | "md";
  className?: string;
}) {
  return (
    <main
      id="main"
      className={cn(
        "relative mx-auto w-full max-w-[440px] pt-[max(8px,env(safe-area-inset-top))] pb-[calc(112px+env(safe-area-inset-bottom))]",
        gutter === "tight" ? "px-3" : "px-5",
        className,
      )}
    >
      {children}
    </main>
  );
}

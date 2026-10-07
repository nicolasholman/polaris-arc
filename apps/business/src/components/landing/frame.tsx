"use client";

import { AppFrame } from "@polaris/ui";
import type { ReactNode } from "react";

/**
 * The landing and sign-in pages sit in ref E's frame, like the dashboard:
 * from 1280px a dark rounded panel floating on the lime canvas, full bleed
 * below.
 */
export function LandingFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <AppFrame panelClassName={className}>{children}</AppFrame>;
}

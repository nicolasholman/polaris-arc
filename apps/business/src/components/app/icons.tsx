"use client";

import { IconProvider } from "@polaris/ui";
import type { ReactNode } from "react";

/** Every lucide icon in the app at the references' 1.75 stroke. */
export function Icons({ children }: { children: ReactNode }) {
  return <IconProvider>{children}</IconProvider>;
}

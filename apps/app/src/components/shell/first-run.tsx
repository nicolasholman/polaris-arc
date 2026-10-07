"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAccountState } from "@/lib/account/hooks";

const SEEN_KEY = "polaris.intro.v1";
const TAB_PATHS = new Set(["/", "/insights", "/cards", "/activity", "/profile"]);

export function markIntroSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* shows again next time; harmless */
  }
}

function introSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * The first time someone opens the app without an account, the tabs hand
 * over to onboarding once. Links from outside (a checkout, a claim) never
 * detour: they create the account inside their own flow.
 */
export function FirstRun() {
  const state = useAccountState();
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  useEffect(() => {
    if (state.status !== "none" || !TAB_PATHS.has(pathname) || introSeen()) return;
    router.replace(`/onboard?next=${encodeURIComponent(pathname)}`);
  }, [state.status, pathname, router]);
  return null;
}

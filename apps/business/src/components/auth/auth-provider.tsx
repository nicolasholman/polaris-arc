"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

import { LOCAL_SESSION_TOKEN } from "@/lib/auth-context";
import { PRIVY_CONFIGURED, PrivyAuthProvider, UnconfiguredAuthProvider } from "./privy-auth";

/**
 * `pnpm demo:local`'s session. NODE_ENV is replaced at build time, so in a
 * production build this is `null` and the module is never compiled into any
 * bundle (no import reaches it).
 */
const LocalAuthProvider =
  process.env.NODE_ENV === "development" ? dynamic(() => import("./local-auth").then((m) => m.LocalAuthProvider)) : null;

/**
 * Sign-in for the landing, /login and the dashboard (the (privy) route
 * group). Not mounted on /gallery or the 404 page, which need no session.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  // Development only; `false` in every production build (see auth-context).
  if (process.env.NODE_ENV === "development" && LOCAL_SESSION_TOKEN && LocalAuthProvider) {
    return <LocalAuthProvider>{children}</LocalAuthProvider>;
  }
  if (!PRIVY_CONFIGURED) return <UnconfiguredAuthProvider>{children}</UnconfiguredAuthProvider>;
  return <PrivyAuthProvider>{children}</PrivyAuthProvider>;
}

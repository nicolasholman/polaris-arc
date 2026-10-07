"use client";

import { BottomNav } from "@polaris/ui";
import { ArrowRightLeft, ChartColumn, CreditCard, House, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { key: "insights", label: "Insights", href: "/insights", icon: <ChartColumn /> },
  { key: "cards", label: "Cards", href: "/cards", icon: <CreditCard /> },
  { key: "home", label: "Home", href: "/", icon: <House /> },
  { key: "activity", label: "Activity", href: "/activity", icon: <ArrowRightLeft /> },
  { key: "profile", label: "Profile", href: "/profile", icon: <User /> },
];

/** Which tab a path belongs to; a sheet opened cold sits over its tab (Home by default). */
export function tabFor(pathname: string): string {
  if (pathname.startsWith("/insights") || pathname.startsWith("/plans")) return "insights";
  if (pathname.startsWith("/cards") || pathname.startsWith("/accounts")) return "cards";
  if (pathname.startsWith("/activity")) return "activity";
  if (pathname.startsWith("/profile") || pathname.startsWith("/settings") || pathname.startsWith("/notifications")) {
    return "profile";
  }
  return "home";
}

/** Ref A's floating glass pill: five round icons, the current tab a lime circle. */
export function TabBar() {
  const pathname = usePathname() ?? "/";
  return <BottomNav floating items={TABS} value={tabFor(pathname)} linkAs={Link} />;
}

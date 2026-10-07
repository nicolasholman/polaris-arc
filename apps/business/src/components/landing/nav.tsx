"use client";

import { PrimaryButton, TopNav, cn } from "@polaris/ui";
import { ArrowRight, CalendarClock, CircleHelp, CodeXml, Landmark, LayoutDashboard, Link2, LogIn, Tag } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { BusinessLogo } from "@/components/app/brand";
import { useOptionalAuth } from "@/lib/auth-context";
import { nav } from "./content";

const ICONS: Record<string, React.ReactNode> = {
  "#ways": <Link2 />,
  "#credit": <CalendarClock />,
  "#developers": <CodeXml />,
  "#payouts": <Landmark />,
  "#pricing": <Tag />,
  "#faq": <CircleHelp />,
};

let networkRead: Promise<string | null> | null = null;

/**
 * Where this server's contracts actually are, from its deployment record
 * (`/api/public/network`): "Local Hardhat" under pnpm demo:local, "Monad
 * Testnet" once deployed there, null while nothing is deployed. undefined
 * while it loads. Read once per page.
 */
export function useNetworkName(): string | null | undefined {
  const [name, setName] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    networkRead ??= fetch("/api/public/network")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: { name?: string } } | null) => body?.data?.name ?? null)
      .catch(() => null);
    let live = true;
    void networkRead.then((n) => {
      if (live) setName(n);
    });
    return () => {
      live = false;
    };
  }, []);
  return name;
}

/** "Local Hardhat", "Monad testnet", or where it is headed when nothing is deployed yet. */
export function networkLabel(name: string | null | undefined): string {
  if (name === undefined) return "AUSD on Monad";
  if (name === null) return "Monad testnet launch in October";
  return name === "Monad Testnet" ? "Monad testnet" : name;
}

/** A dark pill in the wallet pill's shape: where Polaris runs, as this server's deployment says. */
export function NetworkPill({ className }: { className?: string }) {
  const name = useNetworkName();
  return (
    <span className={cn("inline-flex h-11 items-center gap-2.5 rounded-full bg-ui-surface-1 pr-5 pl-4 text-[15px] font-medium whitespace-nowrap", className)}>
      <span aria-hidden className="relative grid size-2.5 place-items-center">
        {name ? <span className="absolute size-2.5 animate-ping rounded-full bg-ui-lime-button/60 motion-reduce:animate-none" /> : null}
        <span className={cn("size-2 rounded-full", name ? "bg-ui-lime-button" : "bg-ui-muted")} />
      </span>
      {name ? `${networkLabel(name)} · AUSD` : networkLabel(name)}
    </span>
  );
}

/**
 * The signed-out top bar, the same on the landing, /login and the 404 (ref
 * E's TopNav): the wordmark, the landing's section links, where Polaris runs,
 * and the lime "Sign in" pill (or "Open dashboard" for a merchant who is
 * already signed in). Phones get the compact bar and a sheet. Off the landing
 * the links go to its sections (`/#ways`); /login leaves out its own Sign in.
 */
export function LandingNav({ onLanding = true, signIn = true, contained = true }: { onLanding?: boolean; signIn?: boolean; contained?: boolean } = {}) {
  const auth = useOptionalAuth();
  const signedIn = auth?.status === "signed-in";
  const cta = signedIn ? (
    <PrimaryButton asChild size="sm" iconRight={<LayoutDashboard />}>
      <Link href="/dashboard">Open dashboard</Link>
    </PrimaryButton>
  ) : (
    <PrimaryButton asChild size="sm" iconRight={<LogIn />}>
      <Link href="/login">Sign in</Link>
    </PrimaryButton>
  );
  return (
    <TopNav
      brand={<BusinessLogo height={30} />}
      brandHref="/"
      brandLabel="Polaris for Business, home"
      items={nav.links.map((l) => ({ key: l.href, label: l.label, href: onLanding ? l.href : `/${l.href}`, icon: ICONS[l.href] }))}
      linkAs="a"
      contained={contained}
      sheetTitle="Polaris for Business"
      actions={
        <>
          <NetworkPill className="hidden xl:inline-flex" />
          {signIn ? cta : null}
        </>
      }
      compactActions={signIn ? cta : undefined}
      sheetFooter={
        <PrimaryButton asChild size="lg" block iconRight={<ArrowRight />}>
          <Link href={signedIn ? "/dashboard" : "/login"}>{signedIn ? "Open dashboard" : "Start accepting payments"}</Link>
        </PrimaryButton>
      }
    />
  );
}

"use client";

import { AppFrame, Avatar, Logo, Menu, PrimaryButton, StatusPill, TopNav, WalletPill } from "@polaris/ui";
import {
  ArrowRightLeft,
  ArrowUpRight,
  Bell,
  CalendarClock,
  ChartColumn,
  ChevronDown,
  CreditCard,
  House,
  Layers,
  LockKeyhole,
  LogOut,
  ScanFace,
  Settings2,
  User,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { accountDigits } from "@/components/accounts";
import { photoFor } from "@/components/avatars";
import { useNotices } from "@/components/use-notices";
import { DEV_SIGNER, signOut } from "@/lib/account";
import { useAccountState, useOwner, usePrivyStatus } from "@/lib/account/hooks";
import { useOrigin } from "@/lib/browser";
import { receiveLink } from "@/lib/links";
import { getProfile } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { usePrefs } from "@/lib/prefs";
import { useDesktopPages } from "./sheet-host";

/** The top nav's links: the phone's tabs, with Pay in 4 promoted from Insights. */
const NAV = [
  { key: "home", label: "Home", href: "/", icon: <House /> },
  { key: "activity", label: "Activity", href: "/activity", icon: <ArrowRightLeft /> },
  { key: "cards", label: "Cards", href: "/cards", icon: <CreditCard /> },
  { key: "plans", label: "Pay in 4", href: "/plans", icon: <CalendarClock /> },
  { key: "insights", label: "Insights", href: "/insights", icon: <ChartColumn /> },
];

/** Behind "More", like the reference's "Market" dropdown. */
const MORE = [
  { key: "credit", label: "Credit", href: "/credit", icon: <Layers />, description: "Your Pay later line and score" },
  { key: "settings", label: "Settings", href: "/settings", icon: <Settings2 />, description: "Your name on links, local currency" },
];

/** Paths that are pages in the frame; any other path is a layer over the page it opened from. */
const PAGE_PATHS = new Set(["/", "/activity", "/cards", "/plans", "/insights", "/credit", "/credit/score", "/settings", "/profile"]);

function navKey(pathname: string): string {
  if (pathname.startsWith("/activity")) return "activity";
  if (pathname.startsWith("/cards") || pathname.startsWith("/accounts")) return "cards";
  if (pathname.startsWith("/plans")) return "plans";
  if (pathname.startsWith("/insights")) return "insights";
  if (pathname.startsWith("/credit")) return "credit";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/profile") || pathname.startsWith("/notifications")) return "profile";
  return "home";
}

/**
 * The customer app from 1024px, in ref E's frame like the merchant web: the
 * dark panel on the lime canvas, and a top nav with the wordmark, the pages,
 * "More", the dollar account's pill (it copies your receive link), the lime
 * Send and your menu. A route that is a page on the desktop (Credit,
 * Settings) shows here in place of the page it opened over; a checkout
 * stands alone, under the wordmark only.
 */
export function DesktopShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { page } = useDesktopPages();
  // The nav follows the page in the frame: a drawer or dialog opened over it
  // (its own URL, /activity/… or /send) leaves the nav where it was.
  const [value, setValue] = useState(() => navKey(pathname));
  const [seen, setSeen] = useState(pathname);
  if (pathname !== seen) {
    setSeen(pathname);
    if (PAGE_PATHS.has(pathname)) setValue(navKey(pathname));
  }

  if (page?.focus) {
    return (
      <AppFrame>
        <header className="flex h-[104px] items-center gap-4 px-10 xl:h-[112px] xl:px-14">
          <Logo height={30} />
          <StatusPill tone="lime" size="sm" icon={<LockKeyhole />} className="font-semibold">
            Secure checkout
          </StatusPill>
        </header>
        <main id="main" tabIndex={-1} className="px-10 pb-14 outline-none xl:px-14">
          {page.content}
        </main>
        <div hidden>{children}</div>
      </AppFrame>
    );
  }

  return (
    <AppFrame>
      <TopNav
        brand={<Logo height={30} />}
        brandHref="/"
        brandLabel="Polaris, home"
        items={NAV}
        more={{ label: "More", items: MORE }}
        value={value}
        linkAs={Link}
        actions={
          <>
            <AccountPill />
            <PrimaryButton asChild size="sm" iconRight={<ArrowUpRight />}>
              <Link href="/send" scroll={false}>
                Send
              </Link>
            </PrimaryButton>
            <AccountMenu />
          </>
        }
      />
      <main id="main" tabIndex={-1} className="px-10 pb-14 outline-none xl:px-14">
        <div className="mx-auto w-full max-w-[1480px]">
          {page ? (
            <>
              <div key={page.key}>{page.content}</div>
              <div hidden>{children}</div>
            </>
          ) : (
            children
          )}
        </div>
      </main>
    </AppFrame>
  );
}

/**
 * "Dollar account ···· 4821": pressing it copies your receive link (the toast
 * shows the site and your name, never the account's address). With no
 * account on this device it says "Create your account", and pressing it
 * starts yours.
 */
function AccountPill() {
  const router = useRouter();
  const state = useAccountState();
  const origin = useOrigin();
  const { name } = usePrefs();
  const address = state.status === "ready" || state.status === "locked" ? state.address : null;
  const link = address && origin ? receiveLink(origin, address, name) : null;
  const digits = (label: string, last4: string) => (
    <>
      {label} <span className="text-ui-muted">····</span> {last4}
    </>
  );
  return (
    <WalletPill
      address={link?.url ?? null}
      displayAddress={link?.shown}
      text={digits("Dollar account", accountDigits(address))}
      label="receive link"
      // Before the device's account is read: no flash of "Create your account".
      pendingText={state.status === "unknown" ? "Dollar account" : "Create your account"}
      pendingLabel="Create your account"
      onPendingClick={state.status === "none" ? () => router.push("/onboard?next=/") : undefined}
      className="hidden xl:inline-flex"
      maxWidth={300}
    />
  );
}

/** Your menu: who you are, how you sign in, and the pages that aren't in the nav. */
function AccountMenu() {
  const router = useRouter();
  const state = useAccountState();
  const owner = useOwner();
  const privy = usePrivyStatus();
  const profile = useData(() => getProfile(owner), [owner]);
  const prefs = usePrefs();
  const { unread } = useNotices();
  const name = prefs.name || profile.value?.name || "Your account";
  const source = state.status === "ready" || state.status === "locked" ? state.source : null;
  const method = source === "privy" ? (privy.email ?? "Email") : source === "dev" || (DEV_SIGNER && source === null) ? "Dev signer" : "Face ID";

  return (
    <Menu
      label="Your account"
      align="end"
      width={300}
      triggerClassName="active:scale-100"
      trigger={
        <span className="relative flex items-center gap-1.5 rounded-full bg-ui-surface-1 p-1 pr-2.5 transition-colors hover:bg-ui-surface-2">
          <Avatar name={name} src={photoFor(name)} size="sm" decorative />
          <ChevronDown aria-hidden size={16} strokeWidth={1.75} className="text-ui-muted" />
          {unread ? <span aria-hidden className="absolute top-1 left-7 size-2.5 rounded-full bg-ui-lime-button ring-2 ring-ui-canvas" /> : null}
        </span>
      }
    >
      <Menu.Header>
        <p className="truncate text-[16px] font-medium">{name}</p>
        <p className="truncate text-[13px] text-ui-muted">{state.status === "none" ? "No account on this device" : method}</p>
      </Menu.Header>
      <Menu.Separator />
      {state.status === "none" ? (
        <Menu.Item icon={<ScanFace />} onSelect={() => router.push("/onboard?next=/")} description="It takes one Face ID">
          Create your account
        </Menu.Item>
      ) : null}
      <Menu.Item icon={<User />} href="/profile" linkAs={Link}>
        Profile
      </Menu.Item>
      <Menu.Item
        icon={<Bell />}
        onSelect={() => router.push("/notifications", { scroll: false })}
        trailing={unread ? <StatusPill tone="lime" size="sm">New</StatusPill> : undefined}
      >
        Notifications
      </Menu.Item>
      <Menu.Item icon={<Settings2 />} href="/settings" linkAs={Link}>
        Settings
      </Menu.Item>
      {state.status === "ready" ? (
        <>
          <Menu.Separator />
          <Menu.Item icon={<LogOut />} tone="danger" onSelect={() => signOut()}>
            Log out
          </Menu.Item>
        </>
      ) : null}
    </Menu>
  );
}

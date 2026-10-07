"use client";

import { AppFrame, Button, ErrorState, Skeleton } from "@polaris/ui";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

import { SetupScreen } from "@/components/app/setup-screen";
import { BusinessLogo } from "@/components/app/brand";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { useAuth } from "@/lib/auth-context";
import { MerchantContext } from "@/lib/merchant-context";
import { useQuery } from "@/lib/session";
import { consumeExplicitSignOut, markExplicitSignOut } from "@/lib/sign-out";

/**
 * Every dashboard page sits behind this gate: Privy must be ready and signed
 * in, and the merchant must have named their business (the one onboarding
 * step, on /login). A visitor who isn't signed in goes to /login and comes
 * back here after; someone who just pressed Sign out goes to /login plain.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? "/dashboard";

  useEffect(() => {
    if (auth.status !== "signed-out") return;
    router.replace(consumeExplicitSignOut() ? "/login" : `/login?next=${encodeURIComponent(pathname)}`);
  }, [auth.status, router, pathname]);

  if (auth.status === "unconfigured") return <SetupScreen />;
  if (auth.status === "unreachable") {
    return (
      <FullPage>
        <ErrorState
          title="We couldn't reach our sign-in service"
          description="Check your connection, or turn off ad and tracker blockers for this site, then try again."
          onRetry={auth.retry}
        />
      </FullPage>
    );
  }
  if (auth.status !== "signed-in") return <FrameSkeleton />;
  return <SignedIn>{children}</SignedIn>;
}

function SignedIn({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/dashboard";
  const { logout, wallet } = useAuth();
  const { data: merchant, error, reload } = useQuery((d) => d.getMerchant());
  // What the server is connected to (chain, relayer, payout signer). Public and
  // secret-free; the money controls read it to say why they're off. Read again
  // every few minutes, and every 10 seconds while it can't be read, so one
  // failed request never leaves the controls "checking" for good.
  const caps = useQuery((d) => d.getCapabilities(), { refreshMs: 300_000 });
  const capabilities = caps.data;
  const capsFailed = Boolean(caps.error) && !capabilities;
  const reloadCaps = caps.reload;
  useEffect(() => {
    if (!capsFailed) return;
    const id = setInterval(reloadCaps, 10_000);
    return () => clearInterval(id);
  }, [capsFailed, reloadCaps]);

  const needsName = merchant !== undefined && !merchant.businessName;
  useEffect(() => {
    if (needsName) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [needsName, router, pathname]);

  // The payout wallet is created right after the first sign-in. Until the
  // server sees it, look again every few seconds, and at once when Privy
  // reports it in this browser.
  const walletPending = merchant !== undefined && !merchant.walletAddress;
  useEffect(() => {
    if (!walletPending) return;
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [walletPending, reload]);
  useEffect(() => {
    if (walletPending && wallet.address) reload();
  }, [walletPending, wallet.address, reload]);

  const capabilitiesError = capsFailed ? caps.error : null;
  const value = useMemo(
    () =>
      merchant
        ? { merchant, refresh: reload, capabilities: capabilities ?? null, capabilitiesError, retryCapabilities: reloadCaps }
        : null,
    [merchant, reload, capabilities, capabilitiesError, reloadCaps],
  );

  if (error && !merchant) {
    return (
      <FullPage>
        <ErrorState
          title="We couldn't open your dashboard"
          description={error}
          onRetry={reload}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                markExplicitSignOut();
                await logout();
                router.replace("/login");
              }}
            >
              Sign out
            </Button>
          }
        />
      </FullPage>
    );
  }
  if (!value || needsName) return <FrameSkeleton />;

  return (
    <MerchantContext.Provider value={value}>
      <DashboardShell merchant={value.merchant}>{children}</DashboardShell>
    </MerchantContext.Provider>
  );
}

function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="grid w-full max-w-[520px] justify-items-center gap-4">
        <BusinessLogo height={32} />
        {children}
      </div>
    </main>
  );
}

/** The frame, loading: the panel, the nav bar, the chart and the widget, so nothing jumps when it arrives. */
function FrameSkeleton() {
  return (
    <AppFrame aria-busy="true" aria-label="Loading your dashboard">
      <div className="flex h-16 items-center justify-between px-4 sm:px-6 lg:h-[104px] lg:px-10 xl:h-[112px] xl:px-14">
        <Skeleton width={150} height={30} />
        <Skeleton shape="pill" width={120} height={44} className="hidden lg:block" />
        <Skeleton width={40} height={40} className="lg:hidden" />
      </div>
      <div className="grid gap-10 px-4 sm:px-6 lg:px-10 xl:grid-cols-[minmax(0,1fr)_400px] xl:px-14">
        <div className="grid content-start gap-5">
          <Skeleton width={260} height={48} />
          <Skeleton width={340} height={44} />
          <Skeleton shape="card" height={360} />
        </div>
        <div className="grid content-start gap-3">
          <Skeleton width={220} height={40} />
          <Skeleton shape="card" height={172} />
          <Skeleton shape="card" height={172} />
          <Skeleton shape="pill" height={50} />
        </div>
      </div>
      <p role="status" className="sr-only">
        Loading your dashboard
      </p>
    </AppFrame>
  );
}

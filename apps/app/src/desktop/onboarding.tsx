"use client";

import { AppFrame, Logo, PageDots, PrimaryButton, SecondaryButton, StatusPill } from "@polaris/ui";
import { AlertCircle, Check, Mail, ScanFace } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { LocalAccount } from "viem";
import { OnboardingArt } from "@/components/onboarding-art";
import { OpenOnPhone, type OpenOnPhoneReason } from "@/components/open-on-phone";
import { markIntroSeen } from "@/components/shell/first-run";
import { continueWithEmail, createAccount, describeAccountError, EMAIL_LOGIN, signIn, toAccountError } from "@/lib/account";
import { useAccountState, useAccountSupport, useInAppBrowser } from "@/lib/account/hooks";
import { safeNext } from "@/lib/next-path";

const PAGES = [
  { line1: "Get paid in dollars.", line2: "Instantly.", sub: "Hold dollars, pay in full, and get paid by anyone, anywhere." },
  { line1: "Split it in four.", line2: "Pay as you go.", sub: "Pay in 4 shows every payment and the total interest before you confirm." },
  { line1: "Send money anywhere.", line2: "By link.", sub: "Share a link. Whoever opens it gets the dollars in under a second." },
] as const;

/**
 * Onboarding from 1024px, in ref E's frame like the merchant's /login: the
 * sign-up on the left (Face ID first, "Continue with email" beneath it) and
 * the three pages of animated art on the right, turning on their own.
 */
export function OnboardingDesktop() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const state = useAccountState();
  const support = useAccountSupport();
  const inApp = useInAppBrowser();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<"face" | "email" | "signin" | null>(null);
  const [error, setError] = useState<{ message: string; kind: string } | null>(null);

  useEffect(() => markIntroSeen(), []);
  useEffect(() => {
    if (state.status === "ready") router.replace(next);
  }, [state.status, next, router]);
  // The art turns every few seconds, unless someone picked a page.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = window.setInterval(() => setPage((p) => (p + 1) % PAGES.length), 6000);
    return () => window.clearInterval(t);
  }, [held]);

  async function run(kind: "face" | "email" | "signin", open: () => Promise<LocalAccount>) {
    setError(null);
    setBusy(kind);
    try {
      await open();
      router.replace(next);
    } catch (e) {
      const err = toAccountError(e);
      if (!(err.kind === "cancelled" && err.message.includes("closed"))) setError({ message: describeAccountError(err), kind: err.kind });
    } finally {
      setBusy(null);
    }
  }

  const blocked: OpenOnPhoneReason | null = inApp
    ? "in-app"
    : support.status === "done" && !support.ok
      ? support.reason
      : error?.kind === "unsupported"
        ? "unsupported"
        : null;
  const returning = state.status === "locked";
  const p = PAGES[page]!;

  return (
    <AppFrame>
      <header className="flex h-[104px] items-center px-10 xl:h-[112px] xl:px-14">
        <Logo height={30} />
      </header>
      <main id="main" className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-center gap-10 px-10 pb-10 xl:gap-16 xl:px-14 xl:pb-14">
        <section aria-labelledby="onboard-title" className="max-w-[480px]">
          <StatusPill tone="lime" size="sm" className="font-semibold">
            {returning ? "Welcome back" : "New to Polaris"}
          </StatusPill>
          <h1 id="onboard-title" className="mt-6 text-[56px] leading-[1.02] font-medium tracking-[-0.04em] text-balance xl:text-[64px]">
            {returning ? (
              <>
                Welcome back.
                <br />
                Face ID opens it.
              </>
            ) : (
              <>
                One look.
                <br />
                You&apos;re in.
              </>
            )}
          </h1>
          <p className="mt-5 text-[17px] leading-relaxed text-ui-muted">
            {returning
              ? "Your Polaris account is on this device."
              : "Face ID is your account: no password, nothing to write down, on this device and your others."}
          </p>

          <div className="mt-8 grid gap-3">
            {blocked ? (
              <div className="rounded-ui-swap bg-ui-surface-1 p-5">
                <OpenOnPhone reason={blocked} compact />
              </div>
            ) : (
              <PrimaryButton
                size="lg"
                block
                icon={<ScanFace />}
                loading={busy === "face"}
                disabled={busy !== null || state.status === "unknown"}
                onClick={() => void run("face", returning ? () => signIn() : createAccount)}
              >
                {returning ? "Open with Face ID" : "Create account with Face ID"}
              </PrimaryButton>
            )}
            {EMAIL_LOGIN ? (
              <SecondaryButton size="lg" block iconRight={<Mail />} loading={busy === "email"} disabled={busy !== null} onClick={() => void run("email", continueWithEmail)}>
                Continue with email
              </SecondaryButton>
            ) : null}
          </div>
          {error && !blocked ? (
            <p role="alert" className="mt-4 flex items-start gap-2 text-[14px] text-ui-down">
              <AlertCircle aria-hidden size={18} strokeWidth={1.75} className="mt-px shrink-0" />
              {error.message}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-1">
            {!returning && !blocked ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run("signin", () => signIn({ anyAccount: true }))}
                className="h-10 rounded-full px-3 text-[15px] text-ui-muted transition-colors hover:text-ui-text"
              >
                I already use Polaris
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => router.replace(next)}
              className="h-10 rounded-full px-3 text-[15px] text-ui-muted transition-colors hover:text-ui-text"
            >
              {next === "/" ? "Look around first" : "Not now"}
            </button>
          </div>
          <ul className="mt-10 grid gap-2.5 border-t border-ui-hairline pt-6 text-[14px] text-ui-muted">
            {["No password, nothing to write down", "Pay in full, in four, or every month", "Send dollars to anyone with a link"].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <Check aria-hidden size={16} strokeWidth={2} className="text-ui-lime-text" />
                {t}
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-roledescription="carousel"
          aria-label="What Polaris does"
          className="relative flex min-h-[600px] flex-col overflow-hidden rounded-[32px] border border-ui-hairline-strong bg-ui-surface-1/40"
        >
          <div className="relative min-h-0 flex-1">
            {PAGES.map((pg, i) => (
              <div
                key={pg.line1}
                aria-hidden={i !== page}
                className="absolute inset-0 transition-opacity duration-700"
                style={{ opacity: i === page ? 1 : 0 }}
              >
                <OnboardingArt page={(i + 1) as 1 | 2 | 3} active={i === page} />
              </div>
            ))}
          </div>
          <div className="relative flex items-end justify-between gap-6 p-8">
            <div aria-live="polite">
              <p className="text-[30px] leading-[1.05] font-medium tracking-[-0.03em]">
                {p.line1}
                <br />
                {p.line2}
              </p>
              <p className="mt-2 max-w-[36ch] text-[15px] leading-relaxed text-ui-muted">{p.sub}</p>
            </div>
            <PageDots
              count={PAGES.length}
              index={page}
              onSelect={(i) => {
                setHeld(true);
                setPage(i);
              }}
              label="What Polaris does"
            />
          </div>
        </section>
      </main>
    </AppFrame>
  );
}

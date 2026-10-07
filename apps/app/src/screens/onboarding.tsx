"use client";

import { Button, IconButton, Logo, PageDots } from "@polaris/ui";
import { AlertCircle, ChevronLeft, Mail, ScanFace } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { LocalAccount } from "viem";
import { OnboardingArt } from "@/components/onboarding-art";
import { OpenOnPhone, type OpenOnPhoneReason } from "@/components/open-on-phone";
import { markIntroSeen } from "@/components/shell/first-run";
import {
  continueWithEmail,
  createAccount,
  describeAccountError,
  EMAIL_LOGIN,
  signIn,
  toAccountError,
} from "@/lib/account";
import { useAccountState, useAccountSupport, useInAppBrowser } from "@/lib/account/hooks";
import { safeNext } from "@/lib/next-path";

const PAGES = [
  { line1: "Get paid in dollars.", line2: "Instantly.", sub: "Hold dollars, pay in full, and get paid by anyone, anywhere." },
  { line1: "Split it in four.", line2: "Pay as you go.", sub: "Pay in 4 shows every payment and the total interest before you confirm." },
  { line1: "Send money anywhere.", line2: "By link.", sub: "Share a link. Whoever opens it gets the dollars in under a second." },
] as const;

/** Onboarding, on ref B's first screen: three pages of glass art, then Face ID (and email beneath it). */
export function Onboarding() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const [step, setStep] = useState<"intro" | "account">("intro");
  const [page, setPage] = useState(0);
  const rail = useRef<HTMLDivElement>(null);

  useEffect(() => markIntroSeen(), []);

  // Follow the swipe: the page whose middle is in view is the current one.
  useEffect(() => {
    const el = rail.current;
    if (!el || step !== "intro") return;
    const onScroll = () => setPage(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [step]);

  const goTo = (i: number) => {
    const el = rail.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: i * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
    setPage(i);
  };

  return (
    <main id="main" className="relative mx-auto flex h-dvh w-full max-w-[440px] flex-col overflow-hidden">
      <header className="relative z-10 flex h-16 shrink-0 items-center gap-2 px-5 pt-[env(safe-area-inset-top)]">
        {step === "account" ? (
          <IconButton label="Back" icon={<ChevronLeft />} tone="ghost" className="-ml-2" onClick={() => setStep("intro")} />
        ) : null}
        {/* The wordmark carries its own star. */}
        <Logo height={30} />
      </header>

      {step === "intro" ? (
        <>
          <div
            ref={rail}
            className="ui-no-scrollbar -mt-16 flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ui-focus"
            role="region"
            aria-roledescription="carousel"
            aria-label="Introduction"
            // Arrow keys scroll it once it has focus.
            tabIndex={0}
          >
            {PAGES.map((p, i) => (
              <section
                key={p.line1}
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} of ${PAGES.length}`}
                className="flex w-full shrink-0 snap-center flex-col px-5"
              >
                <div className="relative -mx-5 min-h-0 flex-1 overflow-hidden">
                  <OnboardingArt page={(i + 1) as 1 | 2 | 3} active={page === i} />
                </div>
                <h1 className="mt-4 text-[length:min(40px,calc((100vw_-_40px)*0.1))] leading-[1.02] font-medium tracking-[-0.04em]">
                  {p.line1}
                  <br />
                  {p.line2}
                </h1>
                <p className="mt-3 max-w-[32ch] text-[15px] leading-[1.45] text-ui-muted">{p.sub}</p>
              </section>
            ))}
          </div>
          <div className="flex shrink-0 flex-col gap-5 px-5 pt-6 pb-[max(20px,env(safe-area-inset-bottom))]">
            <PageDots count={PAGES.length} index={page} onSelect={goTo} label="Introduction" />
            <Button variant="white" size="lg" shape="rounded" block onClick={() => setStep("account")}>
              Get Started
            </Button>
          </div>
        </>
      ) : (
        <AccountStep next={next} onDone={() => router.replace(next)} onSkip={() => router.replace(next)} />
      )}
    </main>
  );
}

/** Face ID makes the account; "Continue with email" sits beneath it. */
function AccountStep({ next, onDone, onSkip }: { next: string; onDone: () => void; onSkip: () => void }) {
  const state = useAccountState();
  const support = useAccountSupport();
  const inApp = useInAppBrowser();
  const [busy, setBusy] = useState<"face" | "email" | "signin" | null>(null);
  const [error, setError] = useState<{ message: string; kind: string } | null>(null);

  useEffect(() => {
    if (state.status === "ready") onDone();
  }, [state.status, onDone]);

  async function run(kind: "face" | "email" | "signin", open: () => Promise<LocalAccount>) {
    setError(null);
    setBusy(kind);
    try {
      await open();
      onDone();
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative -mt-16 min-h-0 flex-1 overflow-hidden">
        <OnboardingArt page={1} className="opacity-60" />
        <div className="absolute inset-0 grid place-items-center">
          <span className="grid size-[132px] place-items-center rounded-full bg-ui-canvas/55 ring-1 ring-white/15 backdrop-blur-xl">
            <ScanFace aria-hidden size={64} strokeWidth={1.25} className="text-ui-lime" />
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-3 px-5 pb-[max(20px,env(safe-area-inset-bottom))]">
        <h1 className="text-[length:min(40px,calc((100vw_-_40px)*0.1))] leading-[1.02] font-medium tracking-[-0.04em]">
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
        <p className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
          {returning
            ? "Your Polaris account is on this phone."
            : "Face ID is your account: no password, nothing to write down, on this phone and your others."}
        </p>

        {blocked ? (
          <div className="mt-2 rounded-ui-tile bg-ui-surface-1 p-4">
            <OpenOnPhone reason={blocked} compact />
          </div>
        ) : (
          <Button
            variant="white"
            size="lg"
            shape="rounded"
            block
            className="mt-3"
            icon={<ScanFace />}
            loading={busy === "face"}
            disabled={busy !== null || state.status === "unknown"}
            onClick={() => void run("face", returning ? () => signIn() : createAccount)}
          >
            {returning ? "Open with Face ID" : "Create account with Face ID"}
          </Button>
        )}
        {EMAIL_LOGIN ? (
          <Button
            variant="dark"
            size="lg"
            shape="rounded"
            block
            icon={<Mail />}
            loading={busy === "email"}
            disabled={busy !== null}
            onClick={() => void run("email", continueWithEmail)}
          >
            Continue with email
          </Button>
        ) : null}
        {error && !blocked ? (
          <p role="alert" className="flex items-start justify-center gap-2 text-center text-[14px] text-ui-down">
            <AlertCircle aria-hidden size={18} strokeWidth={1.75} className="mt-px shrink-0" />
            {error.message}
          </p>
        ) : null}
        <div className="flex items-center justify-center gap-1">
          {!returning && !blocked ? (
            <Button variant="ghost" size="sm" className="text-ui-muted" disabled={busy !== null} onClick={() => void run("signin", () => signIn({ anyAccount: true }))}>
              I already use Polaris
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" className="text-ui-muted" disabled={busy !== null} onClick={onSkip}>
            {next === "/" ? "Look around first" : "Not now"}
          </Button>
        </div>
      </div>
    </div>
  );
}

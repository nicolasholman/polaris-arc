"use client";

import { Button, ErrorState, Input, PrimaryButton, Skeleton, StatusPill, toast } from "@polaris/ui";
import { ArrowRight, Check, LoaderCircle, LockKeyhole, Store } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { SetupScreen } from "@/components/app/setup-screen";
import { LandingFrame } from "@/components/landing/frame";
import { LandingNav } from "@/components/landing/nav";
import { SalesPreview } from "@/components/landing/preview";
import { BlurWords, Rise } from "@/components/motion";
import { useAuth } from "@/lib/auth-context";
import { DataError, errorMessage } from "@/lib/data";
import { safeNext } from "@/lib/next-path";
import { useRegisterMerchant } from "@/lib/payouts";
import { useDashboardData, useQuery } from "@/lib/session";

export function LoginView() {
  const auth = useAuth();
  const next = safeNext(useSearchParams().get("next"));

  if (auth.status === "unconfigured") return <SetupScreen />;

  return (
    <LoginFrame>
      {auth.status === "unreachable" ? (
        <div className="-mx-6">
          <ErrorState
            title="We couldn't reach our sign-in service"
            description="Check your connection, or turn off ad and tracker blockers for this site, then try again."
            onRetry={auth.retry}
            className="items-start px-6 text-left"
          />
        </div>
      ) : auth.status === "signed-in" ? (
        <Onboarding next={next} />
      ) : (
        <SignIn loading={auth.status === "loading"} onContinue={auth.login} />
      )}
    </LoginFrame>
  );
}

/**
 * The page, in ref E's frame: the top nav, the form on the left and, from
 * 1024px, the Overview's chart panel on the right, built from the same
 * components with an invented studio's numbers.
 */
export function LoginFrame({ children }: { children: ReactNode }) {
  return (
    <LandingFrame className="flex flex-col">
      {/* The landing's own bar (same links, same network pill), without a Sign in to the page you are on. */}
      <LandingNav onLanding={false} signIn={false} contained={false} />
      <main className="grid flex-1 grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-10 px-4 pt-4 pb-10 sm:px-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:px-10 lg:pt-6 xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)] xl:px-14 xl:pb-8">
        <div className="flex flex-col">
          <div className="flex flex-1 flex-col justify-center py-6 lg:py-10">
            <div className="w-full max-w-[460px]">{children}</div>
          </div>
          <p className="text-[13px] text-ui-muted">Test mode. No real money moves.</p>
        </div>
        <Showcase />
      </main>
    </LandingFrame>
  );
}

/* ── Signed out: one Continue, Privy's modal does the rest ──────────────── */

function SignIn({ loading, onContinue }: { loading: boolean; onContinue: () => void }) {
  return (
    <div className="grid gap-8">
      <div className="grid gap-5">
        <Rise y={8} duration={0.6}>
          <StatusPill tone="lime" icon={<span className="block size-2 rounded-full bg-current" />}>
            Polaris for Business
          </StatusPill>
        </Rise>
        <BlurWords
          as="h1"
          css
          text={["Get paid in full,", "in under a second."]}
          lineClassName="block"
          className="text-[clamp(38px,4.2vw,56px)] leading-[1.02] font-medium tracking-[-0.045em]"
        />
        <Rise y={10} delay={0.25} duration={0.7}>
          <p className="text-[17px] leading-[1.5] text-ui-muted">
            Sign in to share payment links, follow every Pay in 4 plan and move your money. New here? The same step creates
            your account and your payout account.
          </p>
        </Rise>
      </div>

      <Rise y={10} delay={0.35} duration={0.7} className="grid gap-4">
        <PrimaryButton size="lg" block onClick={onContinue} loading={loading} iconRight={<ArrowRight />} className="h-14 text-[17px]">
          Continue
        </PrimaryButton>
        {loading ? (
          <p role="status" className="text-center text-[14px] text-ui-muted">
            Starting secure sign-in…
          </p>
        ) : null}
        <p className="flex items-start gap-2.5 text-[14px] leading-relaxed text-ui-muted">
          <LockKeyhole aria-hidden size={16} strokeWidth={1.75} className="mt-[3px] shrink-0 text-ui-lime-text" />
          <span>
            Sign-in is by Privy, with the methods shown in the next step. Your payout account is yours alone: we can&rsquo;t move
            money out of it.
          </span>
        </p>
      </Rise>
    </div>
  );
}

/* ── Signed in: name the business once, then in ─────────────────────────── */

/** How long to wait for Privy to finish creating the payout wallet before registering later instead. */
const WALLET_WAIT_MS = 8000;

function Onboarding({ next }: { next: string }) {
  const router = useRouter();
  const data = useDashboardData();
  const { logout, wallet } = useAuth();
  const register = useRegisterMerchant();
  const { data: merchant, error, loading, reload } = useQuery((d) => d.getMerchant());
  const { data: capabilities } = useQuery((d) => d.getCapabilities());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // After the name is saved: register the business on Monad (MerchantRegistry),
  // signed by the payout wallet and sent by the relayer, then open the dashboard.
  const [registering, setRegistering] = useState<{ business: string; done: boolean } | null>(null);
  const started = useRef(false);

  const named = Boolean(merchant?.businessName);
  useEffect(() => {
    if (named && !registering) router.replace(next);
  }, [named, registering, next, router]);

  useEffect(() => {
    if (!registering || started.current) return;
    const finish = (message?: string) => {
      if (message) {
        toast({ title: "Your business isn't registered on Monad yet", description: `${message} You can finish it from the dashboard.`, tone: "info", duration: 8000 });
      }
      router.replace(next);
    };
    if (!wallet.address) {
      const t = setTimeout(() => finish("Your payout account is still being set up."), WALLET_WAIT_MS);
      return () => clearTimeout(t);
    }
    started.current = true;
    register()
      .then(() => {
        setRegistering((r) => (r ? { ...r, done: true } : r));
        setTimeout(() => finish(), 700);
      })
      .catch((err: unknown) => finish(errorMessage(err, "Registration didn't go through.")));
  }, [registering, wallet.address, register, router, next]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const value = name.trim();
    if (value.length < 2) {
      setFormError("Enter your business name as buyers should see it: at least 2 characters.");
      return;
    }
    setBusy(true);
    try {
      await data.updateMerchant({ businessName: value });
      // Register on chain only where it can work: a chain and a relayer. If
      // the capabilities haven't arrived yet, ask for them now rather than
      // skipping registration; if they can't be read, the dashboard offers it.
      const caps = capabilities ?? (await data.getCapabilities().catch(() => null));
      if (caps?.chain && caps.relayer) setRegistering({ business: value, done: false });
      else router.replace(next);
    } catch (err) {
      setFormError(err instanceof DataError ? err.message : errorMessage(err, "We couldn't save that. Try again."));
      setBusy(false);
    }
  }

  const signOut = async () => {
    await logout();
    router.replace("/login");
  };

  if (error && !merchant) {
    return (
      <div className="-mx-6">
        <ErrorState
          title="We couldn't open your account"
          description={error}
          onRetry={reload}
          action={
            <Button variant="outline" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          }
          className="items-start px-6 text-left"
        />
      </div>
    );
  }

  if (registering) {
    const step = registering.done ? "done" : wallet.address ? "sign" : "wallet";
    return <Registering business={registering.business} step={step} />;
  }

  if (loading || !merchant || named) {
    return (
      <div className="grid gap-5" aria-busy="true" aria-label="Opening your dashboard">
        <Skeleton width="80%" height={44} />
        <Skeleton width="100%" height={20} />
        <Skeleton shape="pill" width="100%" height={64} />
        <p role="status" className="text-[14px] text-ui-muted">
          Opening your dashboard…
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={save} noValidate className="grid gap-7">
      <div className="grid gap-4">
        <h1 className="text-[clamp(34px,4.4vw,48px)] leading-[1.04] font-medium tracking-[-0.04em]">
          What&rsquo;s your business called?
        </h1>
        <p className="text-[17px] leading-[1.5] text-ui-muted">
          Buyers see it on every link, checkout and receipt. That&rsquo;s the whole setup: your payout account is already
          being created.
        </p>
      </div>
      <Input
        label="Business name"
        icon={<Store />}
        autoComplete="organization"
        placeholder="Oat & Ember"
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={formError ?? undefined}
        size="lg"
        autoFocus
      />
      <div className="grid gap-3">
        <PrimaryButton type="submit" size="lg" block loading={busy} iconRight={<ArrowRight />} className="h-14 text-[17px]">
          Open the dashboard
        </PrimaryButton>
        <Button variant="ghost" size="md" onClick={() => void signOut()}>
          Use another account
        </Button>
      </div>
    </form>
  );
}

/** The registration step, right after naming the business. */
function Registering({ business, step }: { business: string; step: "wallet" | "sign" | "done" }) {
  const steps = [
    { key: "named", label: `Named ${business}`, state: "done" as const },
    {
      key: "sign",
      label: "Confirm with your payout account",
      state: step === "wallet" ? ("waiting" as const) : step === "sign" ? ("active" as const) : ("done" as const),
    },
    { key: "send", label: "Registered on Monad, fee paid by Polaris", state: step === "done" ? ("done" as const) : ("waiting" as const) },
  ];
  return (
    <div className="grid gap-7" aria-live="polite">
      <div className="grid gap-4">
        <h1 className="text-[clamp(34px,4.4vw,48px)] leading-[1.04] font-medium tracking-[-0.04em]">Registering your business</h1>
        <p className="text-[17px] leading-[1.5] text-ui-muted">
          One confirmation puts {business} and its payout address on Monad, so buyers can pay you. You never need MON: our
          relayer sends it.
        </p>
      </div>
      <ol className="grid gap-2">
        {steps.map((s) => (
          <li key={s.key} className="flex items-center gap-3 rounded-[20px] bg-ui-surface-1 px-4 py-3.5 text-[15px]">
            <span
              className={
                s.state === "done"
                  ? "grid size-7 place-items-center rounded-full bg-ui-lime-button text-[#121418]"
                  : "grid size-7 place-items-center rounded-full bg-ui-surface-2 text-ui-muted"
              }
            >
              {s.state === "done" ? (
                <Check aria-hidden size={15} strokeWidth={2.5} />
              ) : s.state === "active" ? (
                <LoaderCircle aria-hidden size={15} strokeWidth={2} className="animate-spin" />
              ) : null}
            </span>
            <span className={s.state === "waiting" ? "text-ui-muted" : undefined}>{s.label}</span>
          </li>
        ))}
      </ol>
      {step === "wallet" ? <p className="text-[14px] text-ui-muted">Finishing your payout account…</p> : null}
    </div>
  );
}

/* ── The visual: the Overview's chart panel, from the same components ──── */

function Showcase() {
  return (
    <aside aria-hidden className="hidden min-w-0 lg:block">
      <div className="h-full rounded-[32px] border border-ui-hairline-strong p-6 xl:p-8">
        {/* Sized so the whole frame fits a 1440x900 screen without scrolling. */}
        <SalesPreview height={280} rowCount={2} />
      </div>
    </aside>
  );
}

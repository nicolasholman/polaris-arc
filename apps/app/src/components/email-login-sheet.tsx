"use client";

import { AdaptiveSheet, Button, IconDisc, Input, Sheet } from "@polaris/ui";
import { KeyRound, Loader2, Mail } from "lucide-react";
import { type FormEvent, useState } from "react";
import { cancelEmailLogin, finishEmailLogin } from "@/lib/account/email-login";
import { useEmailLoginOpen } from "@/lib/account/hooks";
import { sendEmailCode, verifyEmailCode, waitForPrivyWallet } from "@/lib/account/privy";

type Step = { kind: "email" } | { kind: "code"; email: string } | { kind: "opening" };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Privy's errors, in the buyer's words (never "wallet"). */
function describe(error: unknown, stage: "send" | "verify" | "open"): string {
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (stage === "verify" && (text.includes("code") || text.includes("invalid") || text.includes("incorrect"))) {
    return "That code didn't work. Check it and try again.";
  }
  if (text.includes("too many") || text.includes("rate")) return "Too many tries. Wait a minute, then try again.";
  if (stage === "send") return "We couldn't send a code to that address. Check it and try again.";
  if (stage === "open") return "Your account took too long to open. Try again.";
  return "Something went wrong. Try again.";
}

/**
 * "Continue with email": an address, a six-digit code, and your account is
 * open. Privy sends the code and keeps the account's key; nothing here says
 * wallet. Opened by the account layer (continueWithEmail) from any screen.
 */
export function EmailLoginSheet() {
  const open = useEmailLoginOpen();
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts at the email step.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep({ kind: "email" });
      setCode("");
      setError(null);
      setBusy(false);
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!EMAIL.test(email.trim())) {
      setError("Enter your email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendEmailCode(email);
      setCode("");
      setStep({ kind: "code", email: email.trim() });
    } catch (e) {
      setError(describe(e, "send"));
    } finally {
      setBusy(false);
    }
  }

  async function verify(event?: FormEvent) {
    event?.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the six-digit code from the email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyEmailCode(code);
    } catch (e) {
      setError(describe(e, "verify"));
      setBusy(false);
      return;
    }
    setStep({ kind: "opening" });
    try {
      finishEmailLogin(await waitForPrivyWallet());
    } catch (e) {
      setError(describe(e, "open"));
      setStep({ kind: "email" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdaptiveSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) cancelEmailLogin();
      }}
      snapPoints={["fit"]}
      title="Continue with email"
      description={step.kind === "code" ? `We sent a code to ${step.email}` : "We'll email you a code. No password."}
      maxWidth={440}
    >
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-2">
        {step.kind === "email" ? (
          <form onSubmit={(e) => void send(e)} className="flex flex-col gap-4" noValidate>
            <Input
              label="Email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="you@example.com"
              icon={<Mail />}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error ?? undefined}
              data-autofocus=""
            />
            <Button type="submit" variant="lime" size="lg" block loading={busy}>
              Send code
            </Button>
          </form>
        ) : step.kind === "code" ? (
          <form onSubmit={(e) => void verify(e)} className="flex flex-col gap-4" noValidate>
            <Input
              label="Code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              icon={<KeyRound />}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              error={error ?? undefined}
              className="ui-figure tracking-[0.3em]"
              data-autofocus=""
            />
            <Button type="submit" variant="lime" size="lg" block loading={busy}>
              Continue
            </Button>
            <div className="flex justify-center gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void send()}>
                Send a new code
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStep({ kind: "email" });
                }}
              >
                Use another email
              </Button>
            </div>
          </form>
        ) : (
          <div role="status" className="flex flex-col items-center gap-3 py-6 text-center">
            <IconDisc icon={<Loader2 className="animate-spin motion-reduce:animate-none" />} />
            <p className="text-[15px] text-ui-muted">Opening your account…</p>
          </div>
        )}
        <p className="text-center text-[13px] leading-snug text-ui-muted">
          Your email opens the same account on any device. Face ID stays the fastest way in.
        </p>
      </Sheet.Body>
    </AdaptiveSheet>
  );
}

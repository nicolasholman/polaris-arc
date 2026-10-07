"use client";

import { Button, Notice, StatusPill, toast, type StatusPillTone } from "@polaris/ui";
import { BadgeCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { errorMessage } from "@/lib/data";
import type { Merchant, RegistrationState } from "@/lib/data/types";
import { useMerchant } from "@/lib/merchant-context";
import { useRegisterMerchant } from "@/lib/payouts";
import { useReadiness } from "@/lib/session";
import { TxLink } from "./bits";

const LABEL: Record<RegistrationState, { tone: StatusPillTone; text: string }> = {
  none: { tone: "neutral", text: "Not registered" },
  submitted: { tone: "teal", text: "Registering" },
  registered: { tone: "purple", text: "Registered" },
  active: { tone: "lime", text: "Active" },
  failed: { tone: "red", text: "Didn't go through" },
};

export function registrationOf(merchant: Merchant): RegistrationState {
  return merchant.registration?.state ?? "none";
}

/** The merchant's MerchantRegistry state, as a badge. */
export function RegistrationBadge({ merchant }: { merchant: Merchant }) {
  const l = LABEL[registrationOf(merchant)];
  return (
    <StatusPill tone={l.tone} size="sm">
      {l.text}
    </StatusPill>
  );
}

/**
 * Register the business on Monad from the dashboard: the payout wallet signs
 * the Registration, the relayer sends it. Refreshes the merchant after.
 */
export function useRegisterAction() {
  const register = useRegisterMerchant();
  const { refresh } = useMerchant();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = await register();
      const state = registrationOf(m);
      toast({
        title: state === "active" ? "Registered and active" : state === "registered" ? "Registered on Monad" : "Registration sent",
        description:
          state === "active"
            ? "You can take payments and offer Pay in 4."
            : state === "registered"
              ? "You can take payments now. Pay in 4 opens once Polaris activates your account."
              : "It's on its way to Monad.",
        tone: "success",
      });
    } catch (err) {
      setError(errorMessage(err, "Registration didn't go through. Try again."));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return { run, busy, error };
}

/**
 * The Overview's registration banner: shown until the business is active on
 * Monad, with the one action it needs (or the reason it can't happen yet).
 */
export function RegistrationNotice({ className }: { className?: string }) {
  const { merchant, refresh } = useMerchant();
  const blocker = useReadiness().registration;
  const { run, busy, error } = useRegisterAction();
  const state = registrationOf(merchant);
  // While it's in flight, look again every few seconds: the server checks the
  // registry on each read, so it moves on even if the relay stopped waiting.
  useEffect(() => {
    if (state !== "submitted") return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [state, refresh]);
  if (state === "active") return null;
  const name = merchant.businessName ?? "your business";

  if (state === "registered") {
    const failed = Boolean(merchant.registration?.error);
    return (
      <Notice
        tone="lime"
        icon={<BadgeCheck />}
        className={className}
        title={`${name} is registered on Monad`}
        action={
          failed && !blocker ? (
            <Button variant="outline" size="sm" loading={busy} onClick={() => void run()}>
              Retry activation
            </Button>
          ) : null
        }
      >
        Buyers can pay you now. Pay in 4 opens once Polaris activates your account with its order cap.
        {error ? ` ${error}` : merchant.registration?.error ? ` ${merchant.registration.error}` : ""}
      </Notice>
    );
  }
  if (state === "submitted") {
    return (
      <Notice
        tone="info"
        className={className}
        title="Registering on Monad"
        action={
          <Button variant="outline" size="sm" onClick={refresh}>
            Check again
          </Button>
        }
      >
        The relayer has sent your registration; it confirms in about a second. <TxLink hash={merchant.registration?.txHash ?? null} />
      </Notice>
    );
  }
  return (
    <Notice
      tone={state === "failed" ? "down" : "warn"}
      className={className}
      title={state === "failed" ? "Your registration didn't go through" : `Register ${name} on Monad to take payments`}
      action={
        blocker ? null : (
          <Button variant="lime" size="sm" loading={busy} onClick={() => void run()}>
            {state === "failed" ? "Try again" : "Register"}
          </Button>
        )
      }
    >
      {blocker ??
        (error ||
          merchant.registration?.error ||
          "One confirmation with your payout account puts your business name and payout address on chain. Polaris pays the network fee.")}
    </Notice>
  );
}

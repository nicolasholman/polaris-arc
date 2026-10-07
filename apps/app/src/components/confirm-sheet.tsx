"use client";

import { AdaptiveSheet, Button, IconDisc, Sheet } from "@polaris/ui";
import { AlertCircle, Check, Mail, ScanFace } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { LocalAccount } from "viem";
import {
  type AccountErrorKind,
  authorize,
  continueWithEmail,
  createAccount,
  describeAccountError,
  EMAIL_LOGIN,
  signIn,
  toAccountError,
} from "@/lib/account";
import { useAccountState, useAccountSupport, useInAppBrowser } from "@/lib/account/hooks";
import { RelayError } from "@/lib/relayer";
import { OpenOnPhone, type OpenOnPhoneReason } from "./open-on-phone";

type Stage = "idle" | "auth" | "working";
type Failure = { message: string; kind: AccountErrorKind | "relay" | "other" };

export type ConfirmSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Send $50", "Pay $32.02 to Studio Sol". */
  title: string;
  /** One or two lines of what happens. */
  summary: ReactNode;
  /** The Face ID button for an existing account. */
  confirmLabel?: string;
  /** For a device with no account yet: Face ID creates it and confirms, in one go. */
  newLabel?: string;
  /** While the action runs after Face ID. */
  busyLabel?: string;
  /** A destructive action (cancel a subscription): the button turns red. */
  danger?: boolean;
  /** Runs with the account once Face ID (or the email session) has opened it. */
  onAccount: (account: LocalAccount) => Promise<void>;
  /** After the action succeeded and this sheet started to close. */
  onDone?: () => void;
};

/**
 * Confirm with Face ID: the compact sheet every money action ends in. It
 * knows whether this device has an account and does the right ceremony:
 *
 *   no account  Face ID creates the account and confirms in one go; or
 *               "Continue with email", or "I already use Polaris".
 *   account     Face ID again (or the email session), then the action.
 *   can't       Open on your phone, with email still offered.
 *
 * The ceremony is the first thing the click handler does, so WebKit's
 * user-gesture rule is always met.
 */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  summary,
  confirmLabel = "Confirm with Face ID",
  newLabel = "Confirm with Face ID",
  busyLabel = "Confirming…",
  danger = false,
  onAccount,
  onDone,
}: ConfirmSheetProps) {
  const state = useAccountState();
  const support = useAccountSupport();
  const inApp = useInAppBrowser();
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<Failure | null>(null);

  // Each opening starts fresh.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setError(null);
      setStage("idle");
    }
  }

  async function run(getAccount: () => Promise<LocalAccount>) {
    setError(null);
    setStage("auth");
    let account: LocalAccount;
    try {
      account = await getAccount();
    } catch (e) {
      const err = toAccountError(e);
      setError(err.kind === "cancelled" && err.message.includes("closed") ? null : { message: describeAccountError(err), kind: err.kind });
      setStage("idle");
      return;
    }
    setStage("working");
    try {
      await onAccount(account);
    } catch (e) {
      setError(
        e instanceof RelayError
          ? { message: e.message, kind: "relay" }
          : { message: "That didn't go through, and nothing was charged. Try again.", kind: "other" },
      );
      setStage("idle");
      return;
    }
    setStage("idle");
    onOpenChange(false);
    onDone?.();
  }

  const busy = stage !== "idle";
  const isNew = state.status === "none";
  const email = state.status !== "none" && state.status !== "unknown" && state.source === "privy";
  const faceBlocked: OpenOnPhoneReason | null = inApp
    ? "in-app"
    : support.status === "done" && !support.ok
      ? support.reason
      : error?.kind === "unsupported"
        ? "unsupported"
        : error?.kind === "host" || error?.kind === "insecure"
          ? error.kind
          : null;

  const primaryLabel =
    stage === "auth" ? (email ? "Opening…" : "Waiting for Face ID…") : stage === "working" ? busyLabel : email ? title : isNew ? newLabel : confirmLabel;

  return (
    <AdaptiveSheet
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      dismissible={!busy}
      snapPoints={["fit"]}
      aria-label={title}
      maxWidth={440}
    >
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-4 pt-3 text-center lg:pt-8">
        {faceBlocked && !email ? (
          <OpenOnPhone reason={faceBlocked} compact />
        ) : (
          <>
            <IconDisc icon={email ? <Check /> : <ScanFace size={30} strokeWidth={1.5} />} />
            <div>
              <h2 className="text-[20px] leading-tight font-medium tracking-[-0.02em]">{title}</h2>
              <div className="mx-auto mt-1.5 max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">{summary}</div>
            </div>
            <Button
              variant={danger ? "dark" : "lime"}
              size="lg"
              block
              loading={busy}
              icon={email ? undefined : <ScanFace />}
              className={danger ? "bg-ui-down text-[#0f1011] hover:bg-ui-down/90" : undefined}
              disabled={state.status === "unknown"}
              onClick={() => void run(isNew ? createAccount : () => authorize())}
            >
              {primaryLabel}
            </Button>
          </>
        )}

        {isNew && !busy ? (
          <div className="-mt-1 flex w-full flex-col items-center gap-0.5">
            {EMAIL_LOGIN ? (
              <Button variant="ghost" size="md" icon={<Mail />} block onClick={() => void run(continueWithEmail)}>
                Continue with email
              </Button>
            ) : null}
            {!faceBlocked ? (
              <Button variant="ghost" size="sm" className="text-ui-muted" onClick={() => void run(() => signIn())}>
                I already use Polaris
              </Button>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="flex items-start justify-center gap-2 text-[14px] text-ui-down">
            <AlertCircle aria-hidden size={18} strokeWidth={1.75} className="mt-px shrink-0" />
            <span>
              {error.message}
              {error.kind === "cancelled" && state.status === "locked" && state.source !== "privy" ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className="font-medium text-ui-text underline underline-offset-4"
                    onClick={() => void run(() => signIn({ anyAccount: true }))}
                  >
                    Use a different account
                  </button>
                </>
              ) : null}
            </span>
          </p>
        ) : null}
      </Sheet.Body>
    </AdaptiveSheet>
  );
}

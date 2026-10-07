"use client";

import {
  BalanceSummaryCard,
  Coin,
  CopyButton,
  DetailsList,
  Input,
  Notice,
  PanelCard,
  PolarisCoin,
  PrimaryButton,
  SecondaryButton,
  StatusPill,
  toast,
} from "@polaris/ui";
import { BadgeCheck, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Address } from "@/components/dashboard/bits";
import { PageHead } from "@/components/dashboard/page-head";
import { RegistrationBadge, registrationOf, useRegisterAction } from "@/components/dashboard/registration";
import { QrCode } from "@/components/qr";
import { SIGNER_LABEL, useAuth } from "@/lib/auth-context";
import { DataError, errorMessage } from "@/lib/data";
import { formatDate } from "@/lib/data/format";
import { useMerchant } from "@/lib/merchant-context";
import { useDashboardData, useReadiness } from "@/lib/session";
import { markExplicitSignOut } from "@/lib/sign-out";

/**
 * Settings, behind the top nav's "More": the business name buyers see, the
 * payout wallet, where the business stands on Monad, and signing out.
 */
export function SettingsView() {
  const { merchant, capabilities } = useMerchant();
  const name = merchant.businessName ?? "Your business";

  return (
    <>
      <PageHead
        title="Settings"
        coins={[
          <Coin key="b" tone="orange" size={50}>
            {name.trim()[0]?.toUpperCase() ?? "P"}
          </Coin>,
          <PolarisCoin key="p" size={50} />,
        ]}
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-11 gap-y-4 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_404px]">
        <div className="grid min-w-0 content-start gap-4">
          <BusinessPanel />
          <WalletPanel />
        </div>

        <aside aria-label="Account" className="grid min-w-0 content-start gap-3">
          <BalanceSummaryCard
            label="Mode"
            value="Test mode"
            badge={
              <StatusPill tone="lime" size="sm">
                {capabilities?.chain ? capabilities.chain.name : "Monad testnet"}
              </StatusPill>
            }
            stats={[
              { label: "Currency", value: "AUSD" },
              { label: "Network fee", value: "$0.00" },
              { label: "Settles in", value: "0.8 s" },
            ]}
          />
          <MonadPanel />
          <SignOutButton />
        </aside>
      </div>
    </>
  );
}

function BusinessPanel() {
  const { merchant, refresh } = useMerchant();
  const data = useDashboardData();
  const [name, setName] = useState(merchant.businessName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = name.trim() !== (merchant.businessName ?? "");

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (value.length < 2) {
      setError("Enter your business name as buyers should see it: at least 2 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await data.updateMerchant({ businessName: value });
      toast({ title: "Saved", description: `Buyers now see ${value}.`, tone: "success" });
      refresh();
    } catch (err) {
      setError(err instanceof DataError ? err.message : errorMessage(err, "We couldn't save that. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelCard title="Business" subtitle="What buyers see on your checkouts and receipts">
      <form onSubmit={save} noValidate className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <Input label="Business name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={error ?? undefined} />
        <PrimaryButton type="submit" size="md" loading={busy} disabled={!changed} className="sm:mt-[30px]">
          Save
        </PrimaryButton>
      </form>
      <DetailsList
        className="mt-4"
        size="sm"
        variant="surface"
        items={[
          { label: "Email", value: merchant.email ?? "Not shared" },
          {
            label: "Merchant ID",
            value: merchant.publicId ? (
              <span className="flex min-w-0 items-center justify-end gap-1.5">
                <code className="min-w-0 truncate font-mono text-[13px]">{merchant.publicId}</code>
                <CopyButton value={merchant.publicId} label="merchant ID" tone="ghost" />
              </span>
            ) : (
              "Assigned on first sign-in"
            ),
          },
          { label: "With Polaris since", value: formatDate(merchant.createdAt, true) },
        ]}
      />
    </PanelCard>
  );
}

function WalletPanel() {
  const { merchant } = useMerchant();
  const signer = useAuth().wallet.signer;
  const wallet = merchant.walletAddress;
  return (
    <PanelCard title="Payout wallet" subtitle="An account only you control, created with your sign-in. Every payment settles here in AUSD.">
      {wallet ? (
        <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <span className="w-fit overflow-hidden rounded-[18px]">
            <QrCode value={wallet} label="QR code of your payout wallet address" size={148} />
          </span>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            <div className="flex min-w-0 items-center gap-2 rounded-ui-field bg-ui-surface-1 p-1.5 pl-4">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={wallet}>
                {wallet}
              </code>
              <CopyButton value={wallet} label="payout address" variant="button" buttonVariant="lime" />
            </div>
            <DetailsList
              size="sm"
              variant="surface"
              items={[
                { label: "Explorer", value: <Address value={wallet} label="payout address" /> },
                { label: "Signing", value: SIGNER_LABEL[signer] },
              ]}
            />
          </div>
        </div>
      ) : (
        <p className="mt-4 text-[14px] text-ui-muted">Setting up your wallet… it appears here within a few seconds of your first sign-in.</p>
      )}
    </PanelCard>
  );
}

function MonadPanel() {
  const { merchant } = useMerchant();
  const blocker = useReadiness().registration;
  const { run, busy, error } = useRegisterAction();
  const state = registrationOf(merchant);
  const canRegister = !blocker && (state === "none" || state === "failed");
  return (
    <PanelCard title="On Monad" padding="md" action={<RegistrationBadge merchant={merchant} />}>
      <p className="mt-2 text-[14px] leading-relaxed text-ui-muted">
        {state === "active"
          ? "Registered and active: you take payments and offer Pay in 4."
          : state === "registered"
            ? "Registered: you take payments. Pay in 4 opens once Polaris activates your account."
            : state === "submitted"
              ? "Your registration is on its way to Monad."
              : "Register once so buyers can pay you. Polaris pays the network fee."}
      </p>
      {canRegister ? (
        <PrimaryButton size="md" block icon={<BadgeCheck />} loading={busy} onClick={() => void run()} className="mt-4">
          Register on Monad
        </PrimaryButton>
      ) : blocker && state === "none" ? (
        <p className="mt-3 text-[13px] text-ui-muted">{blocker}</p>
      ) : null}
      {error ? (
        <Notice tone="down" size="sm" className="mt-3" role="alert">
          {error}
        </Notice>
      ) : null}
    </PanelCard>
  );
}

function SignOutButton() {
  const { logout } = useAuth();
  const router = useRouter();
  return (
    <SecondaryButton
      size="lg"
      block
      iconRight={<LogOut />}
      onClick={async () => {
        markExplicitSignOut();
        await logout();
        router.replace("/login");
      }}
    >
      Sign out
    </SecondaryButton>
  );
}

"use client";

import {
  Avatar,
  BalanceSummaryCard,
  Coin,
  Dialog,
  Input,
  ListGroup,
  ListRow,
  Money,
  PanelCard,
  PolarisCoin,
  PrimaryButton,
  SecondaryButton,
  Select,
  Skeleton,
  StatusPill,
} from "@polaris/ui";
import { Bell, Link2, LockKeyhole, LogOut, ScanFace, Settings2, ShieldCheck, Trash2, User, WalletCards } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useAccounts } from "@/components/accounts";
import { ReceiptsPrivacyRow } from "@/components/receipts-privacy";
import { photoFor } from "@/components/avatars";
import { useNotices } from "@/components/use-notices";
import { DEV_SIGNER, EMAIL_LOGIN, signIn, signOut } from "@/lib/account";
import { useAccountState, useOwner, usePrivyStatus } from "@/lib/account/hooks";
import { getPlans, getProfile } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { monthYear } from "@/lib/dates";
import { currencyForLocale, localCurrencyHint, localCurrencyOptions } from "@/lib/money";
import { setPrefs, useLocale, usePrefs } from "@/lib/prefs";
import { n } from "@/lib/view";
import { PageCoin, PageGrid, PageHead, SectionTitle, SideNote } from "./bits";

const HOW: { icon: ReactNode; tone: "lime" | "purple" | "teal" | "orange"; title: string; body: string }[] = [
  {
    icon: <ScanFace />,
    tone: "lime",
    title: "Your account is your Face ID",
    body: EMAIL_LOGIN
      ? "No password, nothing to write down. Or use your email: the same account on any device."
      : "No password, nothing to write down.",
  },
  { icon: <WalletCards />, tone: "purple", title: "Pay now, in four, or every month", body: "Pay in 4 shows every payment and the total interest before you confirm." },
  { icon: <Link2 />, tone: "teal", title: "Send dollars with a link", body: "Share it anywhere. Whoever opens it gets the dollars in under a second." },
  { icon: <ShieldCheck />, tone: "orange", title: "Only you can move your money", body: "Every payment needs your confirmation. Polaris covers the cost of every payment." },
];

/** Who you are, how you sign in: shared by Profile and Settings. */
function useIdentity() {
  const state = useAccountState();
  const owner = useOwner();
  const privy = usePrivyStatus();
  const profile = useData(() => getProfile(owner), [owner]);
  const prefs = usePrefs();
  const name = prefs.name || profile.value?.name || "";
  const source = state.status === "ready" || state.status === "locked" ? state.source : null;
  const method = source === "privy" ? "Email" : source === "dev" || (DEV_SIGNER && source === null) ? "Dev signer" : "Face ID";
  return { state, profile, name, source, method, email: privy.email };
}

/**
 * Profile from 1024px: you, how you sign in, the account's pages, how
 * Polaris works, and on the right your dollar account and Log out.
 */
export function ProfileDesktop() {
  const router = useRouter();
  const { state, profile, name, source, method, email } = useIdentity();
  const owner = useOwner();
  const plans = useData(() => getPlans(owner), [owner]);
  const { balance, credit } = useAccounts();
  const { unread } = useNotices();
  const open = (href: string) => router.push(href, { scroll: false });

  return (
    <>
      <PageHead title="Profile" coins={[<PageCoin key="u" tone="lime"><User /></PageCoin>, <PolarisCoin key="p" size={50} />]} />
      <PageGrid
        main={
          <>
            <div className="flex items-center gap-5">
              {profile.value ? <Avatar name={name || "You"} src={name ? photoFor(name) : undefined} size="xl" /> : <Skeleton shape="circle" width={64} height={64} />}
              <div className="min-w-0">
                <p className="truncate text-[36px] leading-none font-medium tracking-[-0.03em]">{name || "Your account"}</p>
                <p className="mt-2 truncate text-[15px] text-ui-muted">
                  {state.status === "none"
                    ? "No account on this device yet. Create yours in a second."
                    : source === "privy" && email
                      ? email
                      : profile.value?.memberSince
                        ? `Since ${monthYear(profile.value.memberSince)}`
                        : " "}
                </p>
              </div>
              {state.status === "ready" || state.status === "locked" ? (
                <StatusPill tone={state.status === "ready" ? "lime" : "neutral"} className="ml-auto">
                  {state.status === "ready" ? "Open" : "Locked"}
                </StatusPill>
              ) : null}
            </div>

            <SectionTitle className="mt-10">Account</SectionTitle>
            <ListGroup className="mt-4">
                <ListRow icon={<Settings2 />} title="Settings" description="Your name on links, local currency" onClick={() => open("/settings")} />
                <ListRow
                  icon={<Bell />}
                  title="Notifications"
                  description="Payments due and money in"
                  trailing={unread ? <StatusPill tone="lime" size="sm">New</StatusPill> : undefined}
                  chevron
                  onClick={() => open("/notifications")}
                />
                <ListRow
                  icon={source === "privy" ? <Link2 /> : <ScanFace />}
                  title="Sign-in"
                  description={
                    DEV_SIGNER && source !== "privy"
                      ? "A test key stands in for Face ID. Never use it for real money."
                      : source === "privy"
                        ? "Your email opens this account on any device."
                        : "Every payment asks for Face ID."
                  }
                  trailing={<StatusPill tone={method === "Dev signer" ? "amber" : "neutral"} size="sm">{method}</StatusPill>}
                />
            </ListGroup>

            <SectionTitle className="mt-10">How Polaris works</SectionTitle>
            <div className="mt-4 grid grid-cols-2 gap-4">
              {HOW.map((h) => (
                <PanelCard key={h.title} padding="md">
                  <Coin tone={h.tone} size={40}>
                    <span className="inline-grid size-[18px] place-items-center [&_svg]:size-full [&_svg]:stroke-[2.25]">{h.icon}</span>
                  </Coin>
                  <h3 className="mt-4 text-[17px] leading-tight font-medium tracking-[-0.01em]">{h.title}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-ui-muted">{h.body}</p>
                </PanelCard>
              ))}
            </div>
          </>
        }
        side={
          <>
            {balance && credit && plans.value ? (
              <BalanceSummaryCard
                label="Dollar account"
                value={<Money value={n(balance.available)} />}
                stats={[
                  { label: "Score", value: credit.score },
                  { label: "Plans", value: plans.value.plans.filter((p) => p.status === "active").length },
                  ...(profile.value?.memberSince === null
                    ? []
                    : [{ label: "Since", value: profile.value ? monthYear(profile.value.memberSince) : "…" }]),
                ]}
              />
            ) : (
              <Skeleton shape="card" height={170} />
            )}
            {state.status === "none" ? (
              <PrimaryButton size="lg" block icon={<ScanFace />} className="mt-1" onClick={() => router.push("/onboard?next=/profile")}>
                Create your account
              </PrimaryButton>
            ) : null}
            {state.status === "ready" ? (
              <SecondaryButton size="lg" block iconRight={<LogOut />} className="mt-1" onClick={() => signOut()}>
                Log out
              </SecondaryButton>
            ) : state.status === "locked" && source !== "privy" ? (
              <PrimaryButton size="lg" block icon={<ScanFace />} className="mt-1" onClick={() => void signIn().catch(() => undefined)}>
                Open with Face ID
              </PrimaryButton>
            ) : null}
            <SideNote>Polaris 0.2. Your account and your money stay yours: Polaris can&apos;t move them without your Face ID.</SideNote>
          </>
        }
      />
    </>
  );
}

/**
 * Settings from 1024px, a page in the frame: your name on links, your local
 * currency, and the account's actions (Log out, Remove from this device).
 */
export function SettingsDesktop() {
  const { state, profile, method, source } = useIdentity();
  const prefs = usePrefs();
  const locale = useLocale();
  const router = useRouter();
  const [forgetting, setForgetting] = useState(false);
  const auto = locale ? currencyForLocale(locale) : "USD";
  const hasAccount = state.status === "ready" || state.status === "locked";
  const email = hasAccount && source === "privy";

  return (
    <>
      <PageHead title="Settings" coins={[<PageCoin key="s" tone="dark"><Settings2 /></PageCoin>, <PolarisCoin key="p" size={50} />]} />
      <PageGrid
        main={
          <div className="grid gap-4">
            <PanelCard title="Your name on links" subtitle="People see it when you send them dollars, and on your receive link.">
              <Input
                hideLabel
                label="Your name on links"
                value={prefs.name}
                placeholder={profile.value?.name ?? "Your name"}
                maxLength={40}
                autoComplete="name"
                onChange={(e) => setPrefs({ name: e.target.value })}
                wrapperClassName="mt-5 max-w-[480px]"
              />
            </PanelCard>
            <PanelCard title="Local currency" subtitle={localCurrencyHint(prefs.currency ?? auto)}>
              <Select
                variant="filled"
                label="Local currency"
                hideLabel
                value={prefs.currency ?? "auto"}
                onValueChange={(v) => setPrefs({ currency: v === "auto" ? null : v })}
                options={localCurrencyOptions(auto, prefs.currency)}
                wrapperClassName="mt-5 max-w-[480px]"
              />
            </PanelCard>
            {hasAccount && source ? (
              <PanelCard title="Privacy" subtitle="What Polaris can and can't see.">
                <ListGroup className="mt-4">
                  <ReceiptsPrivacyRow source={source} icon={<LockKeyhole />} />
                </ListGroup>
              </PanelCard>
            ) : null}
            {hasAccount ? (
              <PanelCard title="Account" subtitle="Your account and your money stay safe either way.">
                <ListGroup className="mt-4">
                  {state.status === "ready" ? (
                    <ListRow
                      icon={<LogOut />}
                      title="Log out"
                      description={email ? "Your email signs you back in." : "Face ID opens it again."}
                      chevron={false}
                      onClick={() => {
                        signOut();
                        router.push("/");
                      }}
                    />
                  ) : null}
                  <ListRow icon={<Trash2 />} tone="down" title="Remove from this device" description="Your account and money stay safe." chevron={false} onClick={() => setForgetting(true)} />
                </ListGroup>
              </PanelCard>
            ) : null}
          </div>
        }
        side={
          <>
            <BalanceSummaryCard
              label="Signed in with"
              value={state.status === "none" ? "No account" : method}
              badge={hasAccount ? <StatusPill tone={state.status === "ready" ? "lime" : "neutral"} size="sm">{state.status === "ready" ? "Open" : "Locked"}</StatusPill> : undefined}
              stats={[
                { label: "Name on links", value: prefs.name || profile.value?.name || "…" },
                { label: "Currency", value: prefs.currency ?? auto },
              ]}
            />
            <SideNote>Changes save as you type, on this device.</SideNote>
          </>
        }
      />
      <Dialog open={forgetting} onOpenChange={setForgetting} size="sm" title="Remove from this device?">
        <Dialog.Body>
          <p className="text-[15px] leading-[1.45] text-ui-muted">
            Your account and your money stay safe.{" "}
            {email ? "To come back, continue with the same email." : "To come back, choose I already use Polaris and use Face ID."}
          </p>
        </Dialog.Body>
        <Dialog.Footer>
          <SecondaryButton size="md" onClick={() => setForgetting(false)}>
            Keep it
          </SecondaryButton>
          <PrimaryButton
            size="md"
            className="bg-ui-down hover:brightness-105"
            onClick={() => {
              signOut({ forget: true });
              setForgetting(false);
              router.push("/");
            }}
          >
            Remove
          </PrimaryButton>
        </Dialog.Footer>
      </Dialog>
    </>
  );
}

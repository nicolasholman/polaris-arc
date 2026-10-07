"use client";

import {
  AdaptiveSheet,
  Avatar,
  Badge,
  Button,
  Card,
  IconButton,
  ListGroup,
  ListRow,
  ScreenHeader,
  Sheet,
  Skeleton,
  useIsDesktop,
} from "@polaris/ui";
import { Bell, CircleHelp, Link2, LockKeyhole, LogOut, ScanFace, Settings, ShieldCheck, WalletCards } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { photoFor } from "@/components/avatars";
import { InstallHint } from "@/components/install-hint";
import { TabScreen } from "@/components/screen";
import { ProfileDesktop } from "@/desktop/profile";
import { useNotices } from "@/components/use-notices";
import { DEV_SIGNER, EMAIL_LOGIN, signIn, signOut } from "@/lib/account";
import { useAccountState, useOwner, usePrivyStatus } from "@/lib/account/hooks";
import { getProfile } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { monthYear } from "@/lib/dates";
import { usePrefs } from "@/lib/prefs";

const HOW = [
  {
    icon: <ScanFace />,
    title: "Your account is your Face ID",
    body: EMAIL_LOGIN
      ? "No password, nothing to write down. Or use your email: the same account on any device."
      : "No password, nothing to write down.",
  },
  { icon: <WalletCards />, title: "Pay now, in four, or every month", body: "Pay in 4 shows every payment and the total interest before you confirm." },
  { icon: <Link2 />, title: "Send dollars with a link", body: "Share it anywhere. Whoever opens it gets the dollars in under a second." },
  { icon: <ShieldCheck />, title: "Only you can move your money", body: "Every payment needs your confirmation. Polaris covers the cost of every payment." },
  { icon: <LockKeyhole />, title: "Only you can read your receipts", body: "With Face ID, what you buy is sealed to your account. Polaris keeps it, but can't read it." },
];

/** Profile, on ref D's account card: who you are, how you sign in, settings, and sign out. */
export function Profile() {
  return useIsDesktop() ? <ProfileDesktop /> : <ProfilePhone />;
}

function ProfilePhone() {
  const router = useRouter();
  const state = useAccountState();
  const owner = useOwner();
  const privy = usePrivyStatus();
  const profile = useData(() => getProfile(owner), [owner]);
  const prefs = usePrefs();
  const { unread } = useNotices();
  const [how, setHow] = useState(false);
  const open = (href: string) => router.push(href, { scroll: false });

  const name = prefs.name || profile.value?.name || "";
  const source = state.status === "ready" || state.status === "locked" ? state.source : null;
  const method = source === "privy" ? "Email" : source === "dev" || (DEV_SIGNER && source === null) ? "Dev signer" : "Face ID";

  return (
    <TabScreen>
      <ScreenHeader
        title="Profile"
        action={<IconButton label="Notifications" icon={<Bell />} tone="ghost" dot={unread} onClick={() => open("/notifications")} />}
      />

      <Card padding="lg" className="mt-2 flex items-center gap-4">
        {profile.value ? (
          <Avatar name={name || "You"} src={name ? photoFor(name) : undefined} size="xl" />
        ) : (
          <Skeleton shape="circle" width={64} height={64} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[22px] leading-tight font-medium tracking-[-0.02em]">{name || "Your account"}</p>
          <p className="mt-1 truncate text-[14px] text-ui-muted">
            {state.status === "none"
              ? "No account on this device yet. Create yours in a second."
              : source === "privy" && privy.email
                ? privy.email
                : profile.value?.memberSince
                  ? `Since ${monthYear(profile.value.memberSince)}`
                  : " "}
          </p>
        </div>
        {state.status !== "none" && state.status !== "unknown" ? (
          <Badge tone={state.status === "ready" ? "up" : "neutral"} dot>
            {state.status === "ready" ? "Open" : "Locked"}
          </Badge>
        ) : null}
      </Card>

      {state.status === "none" ? (
        <Button variant="lime" size="lg" block icon={<ScanFace />} className="mt-3" onClick={() => router.push("/onboard?next=/profile")}>
          Create your account
        </Button>
      ) : null}

      <ListGroup label="Account" className="mt-6">
        <ListRow icon={<Settings />} title="Settings" description="Your name on links, local currency" onClick={() => open("/settings")} />
        <ListRow
          icon={<Bell />}
          title="Notifications"
          description="Payments due and money in"
          trailing={unread ? <Badge tone="lime">New</Badge> : undefined}
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
          trailing={<Badge tone={method === "Dev signer" ? "warn" : "neutral"}>{method}</Badge>}
        />
        <ListRow icon={<CircleHelp />} title="How Polaris works" onClick={() => setHow(true)} />
      </ListGroup>

      <InstallHint className="mt-3" />

      {state.status === "ready" ? (
        <Button variant="outline" size="lg" block icon={<LogOut />} className="mt-6" onClick={() => signOut()}>
          Log out
        </Button>
      ) : state.status === "locked" && source !== "privy" ? (
        <Button
          variant="outline"
          size="lg"
          block
          icon={<ScanFace />}
          className="mt-6"
          onClick={() => void signIn().catch(() => undefined)}
        >
          Open with Face ID
        </Button>
      ) : null}

      <p className="mt-6 text-center text-[13px] text-ui-muted">Polaris 0.2</p>

      <AdaptiveSheet open={how} onOpenChange={setHow} snapPoints={["half", "full"]} title="How Polaris works" maxWidth={440}>
        <Sheet.Body className="pt-1">
          <ListGroup>
            {HOW.map((h) => (
              <ListRow key={h.title} icon={h.icon} tone="lime" title={h.title} description={h.body} />
            ))}
          </ListGroup>
        </Sheet.Body>
      </AdaptiveSheet>
    </TabScreen>
  );
}

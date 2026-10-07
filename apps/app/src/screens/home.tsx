"use client";

import {
  AppHeader,
  BalanceCard,
  BottomSheet,
  Card,
  ListGroup,
  ListRow,
  QuickTransfer,
  SectionHeader,
  Sheet,
  Skeleton,
  TxRow,
  useIsDesktop,
} from "@polaris/ui";
import { ArrowDown, BadgeDollarSign, CalendarClock, Gauge, Layers, Pencil, Plus, ScanLine, Users, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccounts } from "@/components/accounts";
import { rowAmount } from "@/components/activity-amount";
import { ActivityAvatar, photoFor } from "@/components/avatars";
import { TabScreen } from "@/components/screen";
import { SignAgainNotice } from "@/components/sign-again";
import { useNotices } from "@/components/use-notices";
import { HomeDesktop } from "@/desktop/home";
import { useOwner } from "@/lib/account/hooks";
import { getActivity, getContacts, getPlans, getProfile } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { balanceDelta, DELTA_PERIOD, deltaFigure, subAmount, when } from "@/lib/view";

/** Home: ref A's first screen on a phone, ref E's main screen from 1024px. */
export function Home() {
  return useIsDesktop() ? <HomeDesktop /> : <HomePhone />;
}

/** Home, on ref A's first screen. */
function HomePhone() {
  const router = useRouter();
  const owner = useOwner();
  const profile = useData(() => getProfile(owner), [owner]);
  const contacts = useData(() => getContacts(owner), [owner]);
  const activity = useData(() => getActivity(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const { selected, balance } = useAccounts();
  const { unread } = useNotices();
  const [more, setMore] = useState(false);

  const open = (href: string) => router.push(href, { scroll: false });
  const name = profile.value?.name ?? "";
  // The same change, over the same week, as the desktop's Home and Cards.
  const delta =
    selected?.id === "dollar" && balance && activity.value ? deltaFigure(balanceDelta(balance.available, activity.value)) : undefined;

  return (
    <TabScreen gutter="tight">
      <AppHeader
        logoHref="/"
        linkAs={Link}
        name={name || "Your account"}
        avatarSrc={name ? photoFor(name) : undefined}
        unread={unread}
        onBell={() => open("/notifications")}
        onAvatar={() => router.push("/profile")}
        className="px-2"
      />

      <SignAgainNotice plans={plans.value?.plans} className="mt-1.5" />

      {selected ? (
        <BalanceCard
          className="mt-1.5"
          account={selected.pill}
          onAccountClick={() => open("/accounts")}
          labels={["USD", "AUSD"]}
          balance={selected.balance}
          delta={delta}
          deltaNote={delta !== undefined ? DELTA_PERIOD : undefined}
          quickActions={[
            { label: "Credit line", icon: <Zap fill="currentColor" />, onClick: () => open("/credit") },
            { label: "Edit your name", icon: <Pencil fill="currentColor" />, onClick: () => open("/settings") },
          ]}
          actions={[
            { label: "Add money", icon: <Plus strokeWidth={2.5} />, onClick: () => open("/add") },
            { label: "Receive", icon: <ArrowDown strokeWidth={2.5} />, onClick: () => open("/receive") },
            { label: "Send", icon: <BadgeDollarSign strokeWidth={2.25} />, onClick: () => open("/send") },
          ]}
          more={{ label: "More", onClick: () => setMore(true) }}
        />
      ) : (
        <Skeleton shape="card" height={278} className="mt-1.5" />
      )}

      <Card padding="none" className="mt-3 px-5 pt-5 pb-3">
        <SectionHeader title="Quick transfer" actionLabel="See all" onAction={() => open("/send")} />
        {contacts.value ? (
          <QuickTransfer
            className="mt-4"
            addLabel="Send by link"
            onAdd={() => open("/send")}
            people={contacts.value.map((p) => ({ name: p.name, src: photoFor(p.name) }))}
            onSelect={(p) => {
              const person = contacts.value?.find((c) => c.name === p.name);
              if (person) open(`/send?contact=${person.id}`);
            }}
          />
        ) : (
          <div className="mt-4 flex gap-1 overflow-hidden pb-1" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} shape="circle" width={64} height={64} className="shrink-0" />
            ))}
          </div>
        )}

        <SectionHeader title="Recent activity" actionLabel="See all" onAction={() => router.push("/activity")} className="mt-6" />
        <div className="mt-2 flex flex-col">
          {activity.value
            ? activity.value.slice(0, 5).map((item) => (
                <TxRow
                  key={item.id}
                  leading={<ActivityAvatar item={item} />}
                  title={item.title}
                  subtitle={when(item.at)}
                  {...rowAmount(item)}
                  subAmount={subAmount(item)}
                  onClick={() => open(`/activity/${item.id}`)}
                />
              ))
            : Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="flex h-[60px] items-center gap-3.5">
                  <Skeleton shape="circle" width={44} height={44} />
                  <div className="flex-1 space-y-2">
                    <Skeleton width="45%" height={14} />
                    <Skeleton width="25%" height={10} />
                  </div>
                  <Skeleton width={64} height={14} />
                </div>
              ))}
        </div>
      </Card>

      <BottomSheet open={more} onOpenChange={setMore} snapPoints={["fit"]} title="More" maxWidth={440}>
        <Sheet.Body className="pt-1">
          <ListGroup>
            {[
              { icon: <ScanLine />, title: "Pay or claim a link", description: "Scan a code or paste a link", href: "/pay" },
              { icon: <Users />, title: "Split a bill", description: "One link; everyone pays their share", href: "/split/new" },
              { icon: <Layers />, title: "Credit line", description: "What you can spend with Pay in 4", href: "/credit" },
              { icon: <Gauge />, title: "Credit score", description: "How it moves, week by week", href: "/credit/score" },
              { icon: <CalendarClock />, title: "Plans", description: "Pay in 4 and subscriptions", href: "/insights?view=plans" },
            ].map((row) => (
              <ListRow
                key={row.href}
                icon={row.icon}
                title={row.title}
                description={row.description}
                onClick={() => {
                  setMore(false);
                  if (row.href.startsWith("/insights")) router.push(row.href);
                  else open(row.href);
                }}
              />
            ))}
          </ListGroup>
        </Sheet.Body>
      </BottomSheet>
    </TabScreen>
  );
}

"use client";

import { AssetRow, CardStack, DetailsList, IconButton, ScreenHeader, SectionHeader, Skeleton, useIsDesktop } from "@polaris/ui";
import { ArrowDownToLine, ArrowUpFromLine, Bell, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAccounts } from "@/components/accounts";
import { TabScreen } from "@/components/screen";
import { CardsDesktop } from "@/desktop/cards";
import { useNotices } from "@/components/use-notices";
import { useOwner } from "@/lib/account/hooks";
import { getActivity, getProfile } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { monthYear } from "@/lib/dates";
import { usd } from "@/lib/money";
import { balanceDelta, deltaFigure } from "@/lib/view";

/** Cards, on ref D's balance card with side squares: your account, its three faces, and its details. */
export function Cards() {
  return useIsDesktop() ? <CardsDesktop /> : <CardsPhone />;
}

function CardsPhone() {
  const router = useRouter();
  const owner = useOwner();
  const profile = useData(() => getProfile(owner), [owner]);
  const activity = useData(() => getActivity(owner), [owner]);
  const { accounts, balance, credit } = useAccounts();
  const { unread } = useNotices();
  const open = (href: string) => router.push(href, { scroll: false });
  const dollar = accounts.find((a) => a.id === "dollar");

  return (
    <TabScreen>
      <ScreenHeader
        title="Cards"
        action={<IconButton label="Notifications" icon={<Bell />} tone="ghost" dot={unread} onClick={() => open("/notifications")} />}
      />

      {balance && profile.value && dollar ? (
        <CardStack
          className="mt-2"
          name={profile.value.name}
          last4={dollar.last4}
          meta="USD"
          balance={dollar.balance}
          deltaLabel="This week"
          delta={activity.value ? deltaFigure(balanceDelta(balance.available, activity.value)) : undefined}
          actions={[
            { label: "Add money", icon: <Plus />, tone: "outline", onClick: () => open("/add") },
            { label: "Send", icon: <ArrowUpFromLine />, tone: "mint", onClick: () => open("/send") },
            { label: "Receive", icon: <ArrowDownToLine />, tone: "honey", onClick: () => open("/receive") },
          ]}
        />
      ) : (
        <div className="mt-2 flex gap-3">
          <Skeleton shape="card" height={264} className="flex-1" />
          <div className="flex w-[84px] flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={80} className="rounded-[22px]" />
            ))}
          </div>
        </div>
      )}

      <SectionHeader title="Accounts" actionLabel="Select" onAction={() => open("/accounts")} size="lg" className="mt-7" />
      <div className="mt-3 flex flex-col gap-2">
        {accounts.length
          ? accounts.map((a) => (
              <AssetRow
                key={a.id}
                leading={
                  <span className="grid size-11 place-items-center rounded-full" style={{ background: a.tint }}>
                    {a.mark}
                  </span>
                }
                title={a.title}
                subtitle={`**** ${a.last4}`}
                value={usd(BigInt(Math.round(a.balance * 1e6)))}
                meta={a.caption}
                trend="flat"
                onClick={() => open(`/accounts?account=${a.id}`)}
              />
            ))
          : [0, 1, 2].map((i) => <Skeleton key={i} shape="row" height={72} />)}
      </div>

      <SectionHeader title="Details" size="lg" className="mt-7" />
      <DetailsList
        className="mt-3"
        items={[
          { label: "Holder", value: profile.value?.name ?? "…" },
          { label: "Account", value: dollar ? `**** ${dollar.last4}` : "…" },
          { label: "Currency", value: "US dollars" },
          { label: "Pay later limit", value: credit ? usd(credit.limit, { trim: true }) : "…" },
          { label: "Interest", value: credit ? `${credit.aprBps / 100}% a year` : "…" },
          ...(profile.value?.memberSince === null
            ? []
            : [{ label: "Since", value: profile.value ? monthYear(profile.value.memberSince) : "…" }]),
        ]}
      />
    </TabScreen>
  );
}

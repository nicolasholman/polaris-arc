"use client";

import {
  BalanceSummaryCard,
  CardStack,
  DataTable,
  DeltaChip,
  DollarCoin,
  FigureRow,
  KeyValueGrid,
  Money,
  Skeleton,
  StatusPill,
  TableName,
} from "@polaris/ui";
import { ArrowDownToLine, ArrowUpFromLine, CreditCard, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type AccountView, useAccounts } from "@/components/accounts";
import { useOwner } from "@/lib/account/hooks";
import { getActivity, getProfile } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { monthYear } from "@/lib/dates";
import { usd } from "@/lib/money";
import { balanceDelta, DELTA_PERIOD, deltaFigure, n } from "@/lib/view";
import { PageCoin, PageGrid, PageHead, SectionTitle, SideNote } from "./bits";

const ABOUT: Record<AccountView["id"], string> = {
  dollar: "Get paid, pay in full, send",
  later: "What Pay in 4 can use",
  boost: "Locked to raise your line",
};

/**
 * Cards from 1024px: your three accounts in ref E's table with their details,
 * and ref D's card stack beside them with the dollar account.
 */
export function CardsDesktop() {
  const router = useRouter();
  const owner = useOwner();
  const profile = useData(() => getProfile(owner), [owner]);
  const activity = useData(() => getActivity(owner), [owner]);
  const { accounts, selected, balance, credit, boost } = useAccounts();
  const open = (href: string) => router.push(href, { scroll: false });
  const dollar = accounts.find((a) => a.id === "dollar");
  // The same change, over the same week, as Home.
  const change = balance && activity.value ? balanceDelta(balance.available, activity.value) : undefined;
  const delta = change ? deltaFigure(change) : undefined;

  return (
    <>
      <PageHead title="Cards" coins={[<PageCoin key="c" tone="lime"><CreditCard /></PageCoin>, <DollarCoin key="d" size={50} />]} />
      <PageGrid
        main={
          <>
            {/* The dollars you hold; the Pay later line is credit, said beside it, never added to them. */}
            <FigureRow
              caption="Dollar account"
              value={balance ? <Money value={n(balance.available)} /> : undefined}
              deltaLabel={credit ? `Pay later available: ${usd(credit.available)}` : undefined}
              deltaTitle="What your Pay later line can spend, apart from your dollars"
            />
            <SectionTitle className="mt-10">Accounts</SectionTitle>
            <DataTable
              className="mt-3"
              caption="Your accounts"
              loading={!accounts.length}
              loadingRows={3}
              rows={accounts}
              rowKey={(a) => a.id}
              onRowClick={(a) => open(`/accounts?account=${a.id}`)}
              columns={[
                {
                  key: "account",
                  header: "Account",
                  render: (a) => (
                    <TableName
                      icon={
                        <span className="grid size-8 place-items-center rounded-full" style={{ background: a.tint }}>
                          {a.mark}
                        </span>
                      }
                      title={a.title}
                      sub={`**** ${a.last4}`}
                    />
                  ),
                },
                { key: "what", header: "For", hideBelow: "xl", render: (a) => <span className="text-ui-muted">{ABOUT[a.id]}</span> },
                { key: "balance", header: "Balance", render: (a) => <span className="ui-figure">{usd(BigInt(Math.round(a.balance * 1e6)))}</span> },
                {
                  key: "home",
                  header: "Home",
                  align: "right",
                  render: (a) =>
                    a.id === selected?.id ? (
                      <StatusPill tone="lime">On Home</StatusPill>
                    ) : (
                      <StatusPill tone="neutral">Hidden</StatusPill>
                    ),
                },
              ]}
            />
            <SectionTitle className="mt-10">Details</SectionTitle>
            <KeyValueGrid
              className="mt-4"
              columns={3}
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
          </>
        }
        side={
          <>
            {balance && profile.value && dollar ? (
              <CardStack
                name={profile.value.name}
                last4={dollar.last4}
                meta="USD"
                balance={dollar.balance}
                decimals={2}
                deltaLabel="This week"
                delta={delta}
                actions={[
                  { label: "Add money", icon: <Plus />, tone: "outline", onClick: () => open("/add") },
                  { label: "Send", icon: <ArrowUpFromLine />, tone: "mint", onClick: () => open("/send") },
                  { label: "Receive", icon: <ArrowDownToLine />, tone: "honey", onClick: () => open("/receive") },
                ]}
              />
            ) : (
              <Skeleton shape="card" height={264} />
            )}
            {balance && credit && boost !== undefined ? (
              <BalanceSummaryCard
                className="mt-1"
                label="Dollar account"
                value={<Money value={n(balance.available)} />}
                badge={
                  change?.kind === "pct" ? (
                    <DeltaChip value={change.pct} suffix={DELTA_PERIOD} variant="strong" />
                  ) : (
                    <DeltaChip value={null} label={`${change?.kind === "new" ? "New" : "No change"} ${DELTA_PERIOD}`} variant="strong" />
                  )
                }
                stats={[
                  { label: "Pay later", value: usd(credit.available) },
                  ...(boost ? [{ label: "Boost", value: usd(boost.locked) }] : []),
                  { label: "Fees", value: "None" },
                ]}
              />
            ) : (
              <Skeleton shape="card" height={170} />
            )}
            <SideNote>Choose which account Home shows: open one from the table and pick Show on Home.</SideNote>
          </>
        }
      />
    </>
  );
}

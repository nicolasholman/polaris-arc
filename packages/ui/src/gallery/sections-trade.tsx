"use client";

import {
  ArrowLeftRight,
  CalendarClock,
  CodeXml,
  Copy,
  House,
  Landmark,
  Link2,
  LogOut,
  Plus,
  QrCode,
  RefreshCw,
  Settings,
  Settings2,
  WalletCards,
} from "lucide-react";
import { useMemo, useState, type AnchorHTMLAttributes } from "react";

import { CandlestickChart } from "../charts/CandlestickChart";
import { Chip } from "../primitives/Pill";
import { Avatar } from "../primitives/Avatar";
import { ThemeScope } from "../primitives/Card";
import { Logo } from "../primitives/Logo";
import { Menu } from "../primitives/Menu";
import { AppFrame } from "../trade/AppFrame";
import { BalanceSummaryCard } from "../trade/BalanceSummaryCard";
import { IconSquareButton, PrimaryButton, SecondaryButton } from "../trade/Buttons";
import { ChartTypeToggle, DeltaChip, StatusPill, TextTabs, TimeframeChips, type ChartType } from "../trade/Chips";
import { DataTable, TableName } from "../trade/DataTable";
import { GradientLineChart, type GradientPoint } from "../trade/GradientLineChart";
import { Coin, DollarCoin, PairHeader, PolarisCoin } from "../trade/PairHeader";
import { FigureRow } from "../trade/FigureRow";
import { RunList } from "../trade/RunList";
import { CheckList } from "../composites/CheckList";
import { Meter } from "../primitives/Meter";
import { ProvenanceBadge } from "../primitives/Provenance";
import { TxLink } from "../primitives/TxLink";
import { PanelCard } from "../trade/PanelCard";
import { SwapCard, SwapStack, SwapToggle } from "../trade/Swap";
import { TopNav, WalletPill } from "../trade/TopNav";
import { Section, Specimen } from "./frame";

const NAV = [
  { key: "overview", label: "Overview", href: "#e-overview", icon: <House /> },
  { key: "payments", label: "Payments", href: "#e-payments", icon: <ArrowLeftRight /> },
  { key: "links", label: "Links", href: "#e-links", icon: <Link2 /> },
  { key: "plans", label: "Pay in 4", href: "#e-plans", icon: <CalendarClock /> },
  { key: "payouts", label: "Payouts", href: "#e-payouts", icon: <Landmark /> },
];
const MORE = [
  { key: "developers", label: "Developers", href: "#e-developers", icon: <CodeXml />, description: "Keys, webhooks, the SDK" },
  { key: "settings", label: "Settings", href: "#e-settings", icon: <Settings2 />, description: "Business name, payout wallet" },
];

const WALLET = "0xA7F3d4B8c62369B0fEa91c2D4e8b7a3f5C1d9E02";
const TX = "0x4a3f8c21d9e0b7a65f1c2e3d4b5a69788796a5b4c3d2e1f00112233445566779c21";
const TX2 = "0x9b1e7d3c5a2f4e6d8c0b1a2938475665748392a1b0c9d8e7f6a5b4c3d2e1f0a1b2c3";

/** A day of sales, every 20 minutes: deterministic (no clock, no random), so server and browser agree. */
const DAY: GradientPoint[] = Array.from({ length: 73 }, (_, i) => {
  const t = Date.UTC(2026, 8, 27, 1, 0) + i * 20 * 60_000;
  const v =
    1480 +
    520 * Math.sin(i / 7.5 + 0.6) +
    240 * Math.sin(i / 2.6) +
    120 * Math.cos(i / 1.4) +
    i * 11 -
    (i > 8 && i < 20 ? 420 * Math.sin(((i - 8) / 12) * Math.PI) : 0);
  return { t, value: Math.round(v * 100) / 100 };
});

const CANDLES = Array.from({ length: 24 }, (_, i) => {
  const slice = DAY.slice(i * 3, i * 3 + 4).map((p) => p.value);
  return { t: DAY[i * 3]!.t, o: slice[0]!, c: slice[slice.length - 1]!, h: Math.max(...slice), l: Math.min(...slice) };
});

type Row = { id: string; name: string; tone: "lime" | "blue" | "purple"; mode: string; amount: string; status: [string, "lime" | "purple" | "teal" | "amber"]; net: string };
const ROWS: Row[] = [
  { id: "1", name: "Ana Ruiz", tone: "lime", mode: "Pay now", amount: "$200.00", status: ["Paid", "lime"], net: "$199.00" },
  { id: "2", name: "Kofi Mensah", tone: "purple", mode: "Pay in 4", amount: "$450.00", status: ["Pay in 4", "purple"], net: "$450.00" },
  { id: "3", name: "Mei Tanaka", tone: "blue", mode: "Subscribe", amount: "$120.00", status: ["Monthly", "teal"], net: "$119.40" },
  { id: "4", name: "Lars Berg", tone: "lime", mode: "Pay in 4", amount: "$90.00", status: ["Retrying", "amber"], net: "$90.00" },
];

const time = (t: string | number | Date) =>
  new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Ref E (LumaTrade): the web app's frame, nav, chart and trade widget. */
export function SectionTrade() {
  const [page, setPage] = useState("overview");
  const [type, setType] = useState<ChartType>("line");
  const [tf, setTf] = useState("24h");
  const [tab, setTab] = useState<"withdraw" | "request">("withdraw");
  const [amount, setAmount] = useState("1,250.00");
  const [metric, setMetric] = useState("sales");
  const [ways, setWays] = useState<string[]>(["Now", "In 4"]);
  const [side, setSide] = useState<"buy" | "sell">("buy");

  // The gallery has no routes: nav links switch the active item in place.
  const NavAnchor = useMemo(
    () =>
      function GalleryNavAnchor({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
        return (
          <a
            href={href}
            {...rest}
            onClick={(e) => {
              onClick?.(e);
              const key = href?.replace("#e-", "");
              if (key && [...NAV, ...MORE].some((n) => n.key === key)) {
                e.preventDefault();
                setPage(key);
              }
            }}
          />
        );
      },
    [],
  );

  return (
    <Section
      id="ref-e"
      eyebrow="Reference E · LumaTrade"
      title="The web app: a dark panel on lime"
      description="The merchant web app's frame and components, from ref E: the lime canvas and the floating panel, the top nav with the wallet pill and the lime button, the pair header with overlapping coins, the gradient line chart with its white bubble, the borderless table with status pills, and the stacked-card widget with the swap button, the full-width buttons and the outlined balance card."
    >
      <ThemeScope theme="ref-e" className="grid gap-8">
        {/* The composed reference, at the size the web app uses it. */}
        <AppFrame fullHeight={false} floatFrom="always" className="rounded-[28px] lg:rounded-[40px]">
          <TopNav
            brand={
              <span className="flex items-center gap-2.5">
                <Logo height={30} />
                <StatusPill tone="lime" size="sm">
                  Business
                </StatusPill>
              </span>
            }
            brandHref="#ref-e"
            items={NAV}
            more={{ label: "More", items: MORE }}
            value={page}
            linkAs={NavAnchor}
            actions={
              <>
                <WalletPill address={WALLET} label="payout wallet" maxWidth={230} />
                <PrimaryButton size="sm" iconRight={<Plus />}>
                  New link
                </PrimaryButton>
                <Menu label="Account" align="end" trigger={<Avatar name="Oat & Ember" tone="honey" size="md" decorative />}>
                  <Menu.Header>
                    <p className="text-[15px] font-medium">Oat &amp; Ember</p>
                    <p className="text-[13px] text-ui-muted">ana@oatandember.studio</p>
                  </Menu.Header>
                  <Menu.Separator />
                  <Menu.Item icon={<Copy />}>Copy payout address</Menu.Item>
                  <Menu.Item icon={<LogOut />} tone="danger">
                    Sign out
                  </Menu.Item>
                </Menu>
              </>
            }
            compactActions={<IconSquareButton label="New link" icon={<Plus />} tone="solid" active />}
            sheetFooter={<WalletPill address={WALLET} label="payout wallet" maxWidth={999} className="w-full" />}
          />
          <div className="grid gap-10 px-4 pb-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:px-10 xl:px-14 xl:pb-12">
            <div className="min-w-0">
              <PairHeader
                coins={[<PolarisCoin key="p" />, <DollarCoin key="d" />]}
                title={metric === "sales" ? "Sales / USD" : "Pay in 4 / USD"}
                options={[
                  { value: "sales", label: "Sales / USD" },
                  { value: "later", label: "Pay in 4 / USD" },
                ]}
                value={metric}
                onValueChange={setMetric}
                trailing={<ChartTypeToggle value={type} onValueChange={setType} />}
              />
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="ui-figure text-[42px] leading-none font-medium tracking-[-0.035em]">$39,393.00</span>
                  <DeltaChip value={3.27} suffix="today" />
                </div>
                <TimeframeChips options={["1h", "24h", "1w", "1m"]} value={tf} onValueChange={setTf} />
              </div>
              <div className="mt-6">
                {type === "line" ? (
                  <GradientLineChart label="Sales, the last 24 hours" data={DAY} height={340} formatValue={usd} formatAxis={(v) => usd(v)} formatTime={time} tickZone="utc" lastLabel="Now" />
                ) : (
                  <CandlestickChart label="Sales, hourly candles" data={CANDLES} height={340} formatPrice={(v) => `$${Math.round(v)}`} formatTime={time} />
                )}
              </div>
              <DataTable
                className="mt-8"
                caption="Recent payments"
                columns={[
                  { key: "name", header: "Customer", render: (r) => <TableName icon={<Coin tone={r.tone} size={28}>{r.name[0]}</Coin>} title={r.name} /> },
                  { key: "mode", header: "Mode", hideBelow: "md", render: (r) => r.mode },
                  { key: "amount", header: "Amount", render: (r) => <span className="ui-figure">{r.amount}</span> },
                  { key: "status", header: "Status", render: (r) => <StatusPill tone={r.status[1]}>{r.status[0]}</StatusPill> },
                  { key: "net", header: "Net", align: "right", hideBelow: "sm", render: (r) => r.net },
                ]}
                rows={ROWS}
                rowKey={(r) => r.id}
                onRowClick={() => {}}
              />
            </div>

            <div className="grid content-start gap-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <TextTabs
                  aria-label="Money"
                  options={[
                    { value: "withdraw", label: "Withdraw" },
                    { value: "request", label: "Request" },
                  ]}
                  value={tab}
                  onValueChange={setTab}
                />
                <div className="flex gap-2">
                  <IconSquareButton label="Refresh" icon={<RefreshCw />} />
                  <IconSquareButton label="Show the QR" icon={<QrCode />} />
                  <IconSquareButton label="Settings" icon={<Settings />} />
                </div>
              </div>
              <SwapStack
                top={
                  <SwapCard
                    coin={<PolarisCoin size={42} />}
                    symbol="AUSD"
                    caption="You send"
                    value={amount}
                    onValueChange={setAmount}
                    inputLabel="Amount to withdraw"
                    metaLabel="Balance"
                    meta="3,196.97"
                  />
                }
                bottom={<SwapCard coin={<DollarCoin size={42} />} symbol="USD" caption="Arrives" amount={amount || "0.00"} metaLabel="To" meta="0xA7F3…9E02" />}
                toggle={<SwapToggle label="Switch direction" onClick={() => setTab((t) => (t === "withdraw" ? "request" : "withdraw"))} />}
              />
              <PrimaryButton size="lg" block className="mt-1">
                Withdraw ${amount || "0.00"}
              </PrimaryButton>
              <SecondaryButton size="lg" block iconRight={<WalletCards />}>
                Change payout address
              </SecondaryButton>
              <BalanceSummaryCard
                label="Available balance"
                value="$3,196.97"
                delta={7.45}
                stats={[
                  { label: "Network fee", value: "$0.00" },
                  { label: "You receive", value: `$${amount || "0.00"}` },
                  { label: "Settles in", value: "0.8 s" },
                ]}
              />
            </div>
          </div>
        </AppFrame>

        {/* The pieces. */}
        <div className="grid gap-6 rounded-ui-card bg-ui-canvas p-5 md:p-8 lg:grid-cols-2">
          <Specimen label="PrimaryButton · SecondaryButton">
            <PrimaryButton size="sm" iconRight={<Plus />}>
              New link
            </PrimaryButton>
            <PrimaryButton size="md">Create link</PrimaryButton>
            <SecondaryButton size="md" iconRight={<WalletCards />}>
              Connect wallet
            </SecondaryButton>
          </Specimen>
          <Specimen label="IconSquareButton · ChartTypeToggle">
            <IconSquareButton label="Refresh" icon={<RefreshCw />} />
            <IconSquareButton label="QR" icon={<QrCode />} />
            <IconSquareButton label="Settings" icon={<Settings />} />
            <ChartTypeToggle value={type} onValueChange={setType} />
          </Specimen>
          <Specimen label="StatusPill: lime, purple, teal, amber, red, neutral">
            <StatusPill tone="lime">Limited</StatusPill>
            <StatusPill tone="purple">Trending</StatusPill>
            <StatusPill tone="teal">Rising</StatusPill>
            <StatusPill tone="amber">Retrying</StatusPill>
            <StatusPill tone="red">Failed</StatusPill>
            <StatusPill tone="neutral">Off</StatusPill>
            <StatusPill tone="lime" size="sm">
              Business
            </StatusPill>
          </Specimen>
          <Specimen label="DeltaChip · TimeframeChips · TextTabs">
            <DeltaChip value={3.27} suffix="today" />
            <DeltaChip value={7.45} variant="strong" />
            <DeltaChip value={-1.8} suffix="this week" />
            <DeltaChip value={0} label="No change" suffix="this hour" />
            <DeltaChip value={10.15} suffix="vs last week" goodWhen="down" />
            <TimeframeChips options={["1h", "24h", "1w", "1m"]} value={tf} onValueChange={setTf} />
            <TextTabs
              size="auto"
              aria-label="Specimen tabs"
              options={[
                { value: "buy", label: "Buy" },
                { value: "sell", label: "Sell" },
              ]}
              value={side}
              onValueChange={setSide}
            />
          </Specimen>
          <Specimen label="Option chips (Chip variant pill): the ways a buyer can pay">
            {(["Now", "In 4", "Monthly"] as const).map((w) => (
              <Chip key={w} variant="pill" selected={ways.includes(w)} onClick={() => setWays((c) => (c.includes(w) ? c.filter((x) => x !== w) : [...c, w]))}>
                {w}
              </Chip>
            ))}
          </Specimen>
          <Specimen label="Coins · WalletPill">
            <PolarisCoin />
            <DollarCoin />
            <Coin tone="purple">4</Coin>
            <Coin tone="teal" size={28}>
              M
            </Coin>
            <WalletPill address={WALLET} label="payout wallet" maxWidth={230} />
            <WalletPill address="https://app.polarispay.app/send?to=0x7C80" text="Dollar account ···· 7C80" label="receive link" maxWidth={260} />
          </Specimen>
          <Specimen label="FigureRow: the big figure, its chip and the chips on the right">
            <FigureRow
              className="w-full"
              caption="Spent this week"
              value={<span>$148.49</span>}
              delta={10.15}
              deltaSuffix="vs last week"
              right={<TimeframeChips options={["1w", "1m", "3m"] as const} value="1w" onValueChange={() => undefined} aria-label="Period" />}
            />
          </Specimen>
          <Specimen label="PanelCard: outline, filled">
            <PanelCard title="Customers this week" subtitle="Unique buyers per day" className="w-full sm:w-[260px]">
              <p className="mt-4 text-[32px] font-medium tracking-[-0.03em]">+ 12.4%</p>
            </PanelCard>
            <PanelCard variant="filled" title="Collections" subtitle="Chainlink CRE workflow" className="w-full sm:w-[260px]">
              <p className="mt-4 text-[32px] font-medium tracking-[-0.03em]">in 42 s</p>
            </PanelCard>
          </Specimen>
          <Specimen label="RunList: what an automated job did, with its transaction">
            <RunList
              className="w-full"
              aria-label="Latest collections runs"
              items={[
                { id: "a", tag: "Collected", tone: "lime", title: "2 instalments collected ($100.77)", detail: "Instant retry: 7 s after the buyer signed again", meta: "12 s ago", trailing: <TxLink hash={TX} href="#ref-e" /> },
                { id: "b", tag: "Dunned", tone: "amber", title: "1 task skipped", detail: "1 dunned: approval lost, buyer asked to sign again", meta: "1 min ago", trailing: <TxLink hash={TX2} /> },
                { id: "c", tag: "Paused", tone: "red", title: "Attestation refused", detail: "VerdictMismatch", meta: "9 min ago" },
              ]}
            />
          </Specimen>
          <Specimen label="CheckList · Meter: a guard's checks and how old its last check is">
            <div className="grid w-full gap-5 sm:grid-cols-2">
              <CheckList
                aria-label="The guardian's checks"
                items={[
                  { key: "price", label: "AUSD/USD", value: "$0.9998", limit: "at least $0.995", ok: true },
                  { key: "cash", label: "Free pool cash", value: "$640.00", limit: "at least $1,000.00", ok: false },
                ]}
              />
              <div className="grid content-start gap-2">
                <p className="text-[13px] text-ui-muted">Last checked 12 min ago, of 60</p>
                <Meter value={0.2} label="Time since the last check, of the hour allowed" valueText="12 minutes of 60" />
                <Meter value={0.92} tone="amber" label="Time since the last check" valueText="55 minutes of 60" />
              </div>
            </div>
          </Specimen>
          <Specimen label="ProvenanceBadge · TxLink: where a figure came from">
            <ProvenanceBadge label="Verified by Chainlink CRE" meta="Oct 2, 2026" href="#ref-e" />
            <ProvenanceBadge size="sm" label="Verified by Chainlink CRE" meta="Oct 2" />
            <ProvenanceBadge tone="neutral" label="Chainlink CRE (simulated)" meta="Oct 2, 2026" href="#ref-e" />
            <ProvenanceBadge tone="neutral" size="sm" label="CRE workflow, local run" meta="Oct 2" hash="0x10d38ddb663b14507d34a5af1e5896202c879155c0998b0329e10587f5f12f11" />
            <TxLink hash={TX} href="#ref-e" />
            <TxLink hash={TX} href="#ref-e" kind="report">View report</TxLink>
          </Specimen>
        </div>
      </ThemeScope>
    </Section>
  );
}

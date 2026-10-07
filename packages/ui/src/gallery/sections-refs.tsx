"use client";

import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  BadgeDollarSign,
  BarChart3,
  Coins,
  CreditCard,
  Ellipsis,
  EllipsisVertical,
  Gift,
  History,
  House,
  Layers,
  LineChart,
  Link2,
  LoaderCircle,
  Percent,
  Plus,
  RefreshCw,
  Share2,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  User,
  Wallet,
  Zap,
  Pencil,
  CalendarDays,
  Store,
  Shapes,
  Receipt,
} from "lucide-react";
import { useState } from "react";

import { BarChart } from "../charts/BarChart";
import { CandlestickChart } from "../charts/CandlestickChart";
import { DonutChart } from "../charts/DonutChart";
import { HBarList } from "../charts/HBarList";
import { LineArea } from "../charts/LineArea";
import { ProgressLegend } from "../charts/ProgressLegend";
import { BalanceCard } from "../composites/BalanceCard";
import { CardStack } from "../composites/CardStack";
import { GradientCard } from "../composites/GradientCard";
import { MiniCardCarousel } from "../composites/MiniCardCarousel";
import { AppHeader, BottomNav, ScreenHeader } from "../composites/Navigation";
import { AssetRow, FeaturedTile, QuickTransfer, TileButton } from "../composites/Rows";
import { StatCard } from "../composites/StatCard";
import { DetailsList, KeyValueGrid, StatTile } from "../composites/Stats";
import { TxRow } from "../composites/TxRow";
import { Avatar } from "../primitives/Avatar";
import { Button, IconButton } from "../primitives/Button";
import { Card, SectionHeader } from "../primitives/Card";
import { Select } from "../primitives/Field";
import { AmountDisplay, applyKey, Keypad } from "../primitives/Keypad";
import { LogoMark } from "../primitives/Logo";
import { Money } from "../primitives/Money";
import { PageDots } from "../primitives/PageDots";
import { DeltaBadge, Pill } from "../primitives/Pill";
import { RangeTabs, SegmentedControl, Tab, TabList, Tabs } from "../primitives/Segmented";
import {
  merchants,
  people,
  recentSales,
  salesByMode,
  salesSpark,
  scoreCandles,
  scoreWeeks,
  spendingByCategory,
  spendingWeek,
  transactions,
  volumeCandles,
  weekCustomers,
} from "./data";
import { Screen, Screens, Section } from "./frame";

const TABS_A = [
  { key: "insights", label: "Insights", icon: <BarChart3 /> },
  { key: "cards", label: "Cards", icon: <CreditCard /> },
  { key: "home", label: "Home", icon: <House /> },
  { key: "links", label: "Links", icon: <Link2 /> },
  { key: "profile", label: "Profile", icon: <User /> },
];

function MerchantCircle({ m, size = "md" }: { m: { name: string; color: string }; size?: "sm" | "md" | "lg" }) {
  return m.color ? <Avatar name={m.name} color={m.color} size={size} /> : <Avatar name={m.name} size={size} />;
}

/* ── A · Aheadly ─────────────────────────────────────────────────────────── */

export function SectionA() {
  const [tab, setTab] = useState("home");
  const [tab2, setTab2] = useState("insights");
  const [amount, setAmount] = useState("1250");
  const [from, setFrom] = useState("dollar");
  return (
    <Section
      id="ref-a"
      eyebrow="A · Aheadly"
      title="Home, Send and Insights"
      description="The lime balance card, round actions, quick transfer, transaction rows, the icon nav with a lime active circle, the send screen with the card rail, the big amount and the keypad, and the purple spending card over pastel category bars."
    >
      <Screens>
        <Screen theme="dark" label="Home · BalanceCard, ActionRow, QuickTransfer, TxRow, BottomNav (icons)">
          <AppHeader mark name="Ana Ruiz" unread />
          <BalanceCard
            account="Main account"
            onAccountClick={() => {}}
            labels={["USD", "AUSD"]}
            balance={1284.5}
            delta={2.1}
            quickActions={[
              { label: "Boost", icon: <Zap fill="currentColor" /> },
              { label: "Edit", icon: <Pencil fill="currentColor" /> },
            ]}
            actions={[
              { label: "Add money", icon: <Plus strokeWidth={2.5} /> },
              { label: "Receive", icon: <ArrowDown strokeWidth={2.5} /> },
              { label: "Send", icon: <BadgeDollarSign strokeWidth={2.25} /> },
            ]}
            more={{ label: "More" }}
          />
          <Card variant="raised" radius="card" padding="none" className="-mx-1 px-5 pt-5 pb-3">
            <SectionHeader title="Quick transfer" actionLabel="See all" onAction={() => {}} />
            <QuickTransfer people={people} className="mt-4" />
            <SectionHeader title="Recent transactions" actionLabel="See all" onAction={() => {}} className="mt-6" />
            <div className="mt-2 flex flex-col">
              {transactions.slice(0, 3).map((t) => (
                <TxRow key={t.id} leading={<MerchantCircle m={t.merchant} />} title={t.merchant.name} subtitle={t.time} amount={t.amount} subAmount={t.sub} />
              ))}
            </div>
          </Card>
          <BottomNav items={TABS_A} value={tab} onValueChange={setTab} className="flex justify-center" />
        </Screen>

        <Screen theme="dark" label="Send · ScreenHeader, MiniCardCarousel, AmountDisplay, Keypad">
          <ScreenHeader title="Send" onBack={() => {}} action={<IconButton label="History" icon={<History />} tone="ghost" />} />
          <TxRow
            static
            variant="card"
            className="rounded-ui-tile"
            leading={<Avatar name="Priya Shah" tone="pink" size="md" />}
            title="Priya Shah"
            subtitle="+1 (555) 654-2164"
            value={<IconButton label="Change recipient" icon={<RefreshCw />} tone="ghost" className="-mr-2 text-ui-muted" />}
          />
          <MiniCardCarousel
            aria-label="Pay from"
            value={from}
            onValueChange={setFrom}
            cards={[
              { id: "dollar", mark: <LogoMark size={20} title="" />, title: "Dollar account", balance: 1284.5 },
              { id: "later", mark: <Layers size={18} strokeWidth={1.75} className="text-ui-lime" />, title: "Pay later line", balance: 500 },
              { id: "boost", mark: <Sparkles size={18} strokeWidth={1.75} className="text-ui-yellow" />, title: "Boost", balance: 120 },
              { id: "card", mark: <CreditCard size={18} strokeWidth={1.75} />, last4: "4523", balance: 18652.11 },
            ]}
          />
          <AmountDisplay value={amount} hint="Available $1,284.50" invalid={Number(amount) > 1284.5} className="py-2" />
          <Button variant="lime" size="xl" block>
            Send
          </Button>
          <Keypad onKey={(k) => setAmount((a) => applyKey(a, k))} onClear={() => setAmount("")} />
        </Screen>

        <Screen theme="dark" label="Insights · GradientCard (purple) + LineArea, Tabs (text), HBarList">
          <ScreenHeader title="Insights" onBack={() => {}} action={<IconButton label="More" icon={<Ellipsis />} tone="ghost" />} />
          <GradientCard
            tone="purple"
            layout="side"
            label="My spending"
            value={<Money value={846.13} dim="none" />}
            meta={<DeltaBadge value={10.08} note="From last week" size="sm" tone="current" />}
            chart={<LineArea label="Spending this week" data={spendingWeek} height={78} curve="linear" strokeWidth={2} glow={false} />}
          />
          <div className="flex items-center justify-between">
            <Tabs defaultValue="expenses" variant="text">
              <TabList aria-label="Insights view">
                <Tab value="expenses">Expenses</Tab>
                <Tab value="plans">Plans</Tab>
              </TabList>
            </Tabs>
            <IconButton label="Pick month" icon={<CalendarDays />} tone="surface" size="lg" />
          </div>
          <HBarList label="Spending by category" data={spendingByCategory} />
          <BottomNav items={TABS_A} value={tab2} onValueChange={setTab2} className="flex justify-center" />
        </Screen>
      </Screens>
    </Section>
  );
}

/* ── B · Findex ──────────────────────────────────────────────────────────── */

export function SectionB() {
  const [range, setRange] = useState("6M");
  const [chart, setChart] = useState<"line" | "candles">("line");
  const [order, setOrder] = useState("now");
  const [tab, setTab] = useState("home");
  const [dot, setDot] = useState(0);
  return (
    <Section
      id="ref-b"
      eyebrow="B · Findex"
      title="Credit, the score chart and onboarding"
      description="The crimson portfolio card, featured tiles, watchlist rows with sparklines, the purple chart card with range tabs, stat tiles, the segmented control, the rounded Sell/Buy pair, and the white Get Started."
    >
      <Screens>
        <Screen theme="dark" label="Credit · GradientCard (crimson), FeaturedTile, AssetRow, BottomNav (white)">
          <AppHeader name="Kofi Mensah" />
          <GradientCard
            tone="crimson"
            label="Your credit line"
            value={<Money value={500} dim="cents" dimOpacity={0.55} />}
            meta={<DeltaBadge variant="chip" value={2.5} amount="$12.50" />}
          />
          <SectionHeader title="Active plans" actionLabel="See all" onAction={() => {}} />
          <div className="ui-no-scrollbar -mx-5 flex gap-3 overflow-x-auto px-5">
            <FeaturedTile
              leading={<MerchantCircle m={merchants.oat} />}
              title="Oat & Ember"
              subtitle="Pay in 4"
              value="$90.00"
              meta="Next Oct 12"
              progress={{ done: 2, total: 4 }}
              tint={merchants.oat.color}
            />
            <FeaturedTile
              leading={<MerchantCircle m={merchants.northwind} />}
              title="Northwind"
              subtitle="Pay in 4"
              value="$32.10"
              meta="Next Oct 15"
              progress={{ done: 3, total: 4 }}
              tint={merchants.northwind.color}
            />
            <FeaturedTile
              leading={<MerchantCircle m={merchants.luma} />}
              title="Luma"
              subtitle="Monthly"
              value="$29.00"
              meta={<DeltaBadge value={3.25} size="sm" />}
              tint={merchants.luma.color}
            />
          </div>
          <SectionHeader title="Upcoming" actionLabel="See all" onAction={() => {}} />
          <div className="flex flex-col gap-2">
            <AssetRow leading={<MerchantCircle m={merchants.oat} />} title="Oat & Ember" subtitle="Oct 12 · 3 of 4" spark={[30, 27, 29, 26, 24, 25, 22]} trend="down" value="$14.75" meta="-$14.75" />
            <AssetRow leading={<MerchantCircle m={merchants.kiko} />} title="Kiko Ramen" subtitle="Oct 14 · 2 of 4" spark={[10, 14, 12, 16, 15, 19, 18]} value="$9.40" meta="+2.24%" />
            <AssetRow leading={<MerchantCircle m={merchants.arc} />} title="Arc Cycles" subtitle="Oct 20 · 1 of 4" spark={[40, 42, 39, 44, 47, 45, 49]} value="$77.50" meta="+4.45%" />
          </div>
          <BottomNav
            activeTone="white"
            items={[
              { key: "home", label: "Home", icon: <House /> },
              { key: "plans", label: "Plans", icon: <Coins /> },
              { key: "profile", label: "Profile", icon: <User /> },
            ]}
            value={tab}
            onValueChange={setTab}
            className="flex justify-center"
          />
        </Screen>

        <Screen theme="dark" label="Credit score · purple chart card, RangeTabs, StatTile, SegmentedControl">
          <ScreenHeader
            variant="square"
            title="Credit score"
            subtitle="Updated today"
            logo={<LogoMark size={34} title="" />}
            onBack={() => {}}
            action={<IconButton label="More" icon={<EllipsisVertical />} shape="square" tone="surface" />}
          />
          <GradientCard
            tone="purple-chart"
            value={<span className="ui-figure">648</span>}
            actions={
              <div className="flex items-center gap-1 rounded-[14px] bg-black/15 p-1">
                <IconButton
                  label="Line chart"
                  icon={<LineChart />}
                  shape="square"
                  size="sm"
                  tone={chart === "line" ? "white" : "glass"}
                  className="size-9"
                  onClick={() => setChart("line")}
                  aria-pressed={chart === "line"}
                />
                <IconButton
                  label="Candles"
                  icon={<LoaderCircle />}
                  shape="square"
                  size="sm"
                  tone={chart === "candles" ? "white" : "glass"}
                  className="size-9"
                  onClick={() => setChart("candles")}
                  aria-pressed={chart === "candles"}
                />
              </div>
            }
            meta={<DeltaBadge variant="chip" value={1.9} amount="+12" />}
            chart={
              chart === "line" ? (
                <LineArea label="Credit score by week" data={scoreWeeks} height={190} reference="avg" interactive />
              ) : (
                <div className="px-3">
                  <CandlestickChart label="Credit score by week" data={scoreCandles} height={190} formatPrice={(v) => String(Math.round(v))} className="bg-black/20" />
                </div>
              )
            }
          >
            <RangeTabs className="mt-5" value={range} onValueChange={setRange} onCalendar={() => {}} />
          </GradientCard>
          <div className="grid grid-cols-3 gap-2.5">
            <StatTile value="8" label="On time" />
            <StatTile value="$500" label="Your line" />
            <StatTile value="$1,000" label="Next tier" tone="up" />
          </div>
          <Card variant="raised" radius="tile" padding="md">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[16px] text-ui-muted">Pay</span>
              <SegmentedControl
                aria-label="Payment type"
                value={order}
                onValueChange={setOrder}
                options={[
                  { value: "now", label: "Market" },
                  { value: "limit", label: "Limit" },
                ]}
              />
            </div>
            <div className="mt-4 flex items-baseline justify-between">
              <span className="flex items-baseline gap-2">
                <span className="ui-figure text-[36px] leading-none font-medium tracking-[-0.03em]">24</span>
                <Money value={17506.56} dim="none" className="text-[14px] text-ui-muted" />
              </span>
              <span className="text-[13px] text-ui-muted">Fee: ~$8.50</span>
            </div>
          </Card>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="dark" shape="rounded" size="lg">
              Pay early
            </Button>
            <Button variant="white" shape="rounded" size="lg">
              Raise limit
            </Button>
          </div>
        </Screen>

        <Screen theme="dark" label="Onboarding · headline, dots, white Button" className="min-h-[640px] justify-end">
          <div className="flex items-center gap-2.5 pt-3">
            <LogoMark size={34} title="" />
          </div>
          <div className="flex-1" />
          <h3 className="text-[40px] leading-[1.02] font-medium tracking-[-0.035em]">
            Get paid in dollars.
            <br />
            Instantly.
          </h3>
          <p className="max-w-[30ch] text-[15px] leading-[1.45] text-ui-muted">
            Pay in full, in four or every month, and send dollars anywhere with a link.
          </p>
          <PageDots count={3} index={dot} onSelect={setDot} label="Introduction" />
          <Button variant="white" size="lg" shape="rounded" block>
            Get Started
          </Button>
          <Button variant="ghost" size="md" block className="-mt-2 text-ui-muted">
            Continue with email
          </Button>
        </Screen>
      </Screens>
    </Section>
  );
}

/* ── C · Trading ─────────────────────────────────────────────────────────── */

export function SectionC() {
  const [tab, setTab] = useState("home");
  const [tf, setTf] = useState("1W");
  const [mode, setMode] = useState("four");
  const [metric, setMetric] = useState("volume");
  return (
    <Section
      id="ref-c"
      eyebrow="C · Trading"
      title="The light shell, candles and checkout"
      description="Candlesticks on the dark panel (lime up, purple down, the dashed last-price line and tags, timeframe chips, a crosshair on hover and drag), the key-value grid, the details list, the Send/Receive/Top Up tiles, the labelled pill nav, and purple Pay in 4 beside lime Pay now."
    >
      <Screens>
        <Screen theme="light" label="Home (light) · AppHeader (greeting), TileButton, AssetRow, BottomNav (labelled)">
          <AppHeader variant="greeting" name="Leo Park" />
          <Card variant="canvas" radius="card" padding="lg">
            <div className="flex items-start justify-between">
              <span className="pt-2 text-[14px] text-ui-muted">Total balance</span>
              <Pill tone="ink" size="lg" icon={<Gift />} onClick={() => {}}>
                Rewards
              </Pill>
            </div>
            <Money value={2525} dim="none" className="mt-8 text-[48px] leading-none font-semibold tracking-[-0.035em]" />
            <div className="mt-2 flex items-center gap-2 text-[15px]">
              <Money value={173.72} dim="none" className="text-ui-muted" />
              <span className="ui-figure font-medium text-ui-up">+6.88%</span>
            </div>
          </Card>
          <div className="-mt-2 grid grid-cols-3 gap-2.5">
            <TileButton tone="ink" icon={<ArrowUpRight />} label="Send" />
            <TileButton tone="purple" icon={<ArrowDownLeft />} label="Receive" />
            <TileButton tone="lime" icon={<Plus />} label="Top Up" />
          </div>
          <SectionHeader title="Favorites" size="lg" action={<IconButton label="Filter" icon={<SlidersHorizontal />} tone="ink" />} />
          <div className="flex flex-col gap-2.5">
            <AssetRow variant="sunken" sparkFill leading={<MerchantCircle m={merchants.luma} />} title="Luma Studio" subtitle="Subscription" spark={[4, 7, 5, 8, 6, 9, 7, 10, 9, 12]} value="$395.27" meta="+7.48%" />
            <AssetRow variant="sunken" sparkFill leading={<MerchantCircle m={merchants.field} />} title="Field Goods" subtitle="Pay in 4" spark={[3, 6, 4, 7, 5, 8, 6, 9, 8, 11]} value="$291.08" meta="+4.82%" />
            <AssetRow variant="sunken" sparkFill leading={<MerchantCircle m={merchants.kiko} />} title="Kiko Ramen" subtitle="Paid in full" spark={[12, 9, 11, 8, 10, 7, 9, 6, 8, 5]} value="$136.64" meta="-5.39%" />
          </div>
          <BottomNav
            variant="labelled"
            items={[
              { key: "home", label: "Home", icon: <House /> },
              { key: "activity", label: "Activity", icon: <Receipt /> },
              { key: "plans", label: "Plans", icon: <Coins /> },
              { key: "more", label: "More", icon: <Shapes /> },
            ]}
            value={tab}
            onValueChange={setTab}
            className="flex justify-center"
          />
        </Screen>

        <Screen theme="light" label="Checkout · CandlestickChart, SegmentedControl, purple + lime Buttons">
          <ScreenHeader
            variant="arrow"
            title="Oat & Ember"
            subtitle="Order #4821"
            onBack={() => {}}
            action={<IconButton label="Share" icon={<Share2 />} tone="ink" />}
          />
          <Card variant="canvas" radius="tile" padding="md" className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[14px] text-ui-muted">Total</div>
              <Money value={128.06} dim="none" className="mt-1 text-[36px] leading-none font-medium tracking-[-0.03em]" />
            </div>
            <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-[14px]">
              <dt className="text-ui-muted">Pay in 4</dt>
              <dd className="ui-figure text-right">$32.02</dd>
              <dt className="text-ui-muted">Interest</dt>
              <dd className="ui-figure text-right">$0.00</dd>
              <dt className="text-ui-muted">Fees</dt>
              <dd className="ui-figure text-right">$0.00</dd>
            </dl>
          </Card>
          <CandlestickChart
            label="Daily payment volume, thousands of dollars"
            data={volumeCandles}
            height={330}
            reference={{ value: 97.45 }}
            timeframes={["1D", "1W", "1M", "3M"]}
            timeframe={tf}
            onTimeframeChange={setTf}
            onTypeToggle={() => {}}
            leading={
              <Select
                aria-label="Metric"
                variant="chip"
                size="sm"
                value={metric}
                onValueChange={setMetric}
                options={[
                  { value: "volume", label: "Volume" },
                  { value: "count", label: "Count" },
                ]}
                className="h-9 px-3.5"
              />
            }
          />
          <Card variant="canvas" radius="tile" padding="md">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[16px] text-ui-muted">Pay</span>
              <SegmentedControl
                aria-label="How to pay"
                shape="pill"
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "now", label: "Pay now" },
                  { value: "four", label: "Pay in 4" },
                ]}
              />
            </div>
          </Card>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="purple" size="lg">
              Pay in 4
            </Button>
            <Button variant="lime-bright" size="lg">
              Pay now
            </Button>
          </div>
        </Screen>

        <Screen theme="light" label="Details · KeyValueGrid, DetailsList">
          <ScreenHeader variant="arrow" title="Plan details" subtitle="Oat & Ember" onBack={() => {}} action={<IconButton label="Share" icon={<Share2 />} tone="ink" />} />
          <KeyValueGrid
            variant="sunken"
            items={[
              { label: "Amount", value: "$128.06" },
              { label: "Pay in 4", value: "$32.02 × 4" },
              { label: "Interest", value: "$0.00" },
              { label: "First payment", value: "Today" },
              { label: "Paid so far", value: "$64.04" },
              { label: "Left to pay", value: "$64.02" },
            ]}
          />
          <DetailsList
            variant="sunken"
            items={[
              { label: "Merchant", value: "Oat & Ember" },
              { label: "Order", value: "#4821" },
              { label: "Second payment", value: "Oct 10, 2026" },
              { label: "Third payment", value: "Oct 24, 2026" },
              { label: "Last payment", value: "Nov 7, 2026" },
            ]}
          />
          <div className="grid grid-cols-2 gap-3">
            <Button variant="purple" size="lg">
              Pay early
            </Button>
            <Button variant="lime-bright" size="lg">
              Pay now
            </Button>
          </div>
        </Screen>
      </Screens>
    </Section>
  );
}

/* ── D · Sales ───────────────────────────────────────────────────────────── */

export function SectionD() {
  const [every, setEvery] = useState("2h");
  return (
    <Section
      id="ref-d"
      eyebrow="D · Sales"
      title="The merchant's analytics"
      description="The sales card with a sparkline and a delta chip, the weekly bars with a tooltip, the donut with floating value tags, the progress legend, recent-sales rows, and the balance card with side action squares."
    >
      <Screens>
        <Screen theme="dark" label="Sales · StatCard, BarChart, Select (outline), TxRow (card)" className="bg-black">
          <div className="-mx-5 flex gap-3 overflow-hidden px-5">
            <StatCard
              tone="sage"
              icon={<Percent />}
              label="Sales"
              delta={23}
              value={<Money value={24575} decimals={0} spaced dim="none" />}
              spark={salesSpark}
              className="w-full shrink-0"
            />
          </div>
          <div>
            <SectionHeader title="Customers this week" size="lg" />
            <div className="mt-2 flex items-end justify-between">
              <span className="ui-figure text-[40px] leading-none font-bold tracking-[-0.03em]">+ 2.1%</span>
              <button type="button" className="text-[15px] text-ui-muted hover:text-ui-text">
                See all
              </button>
            </div>
          </div>
          <BarChart label="Customers this week" data={weekCustomers} height={170} formatValue={(v) => `$ ${v.toLocaleString("en-US")}`} />
          <SectionHeader
            title="Last orders"
            size="lg"
            action={
              <Select
                aria-label="Refresh"
                variant="outline"
                value={every}
                onValueChange={setEvery}
                align="end"
                options={[
                  { value: "1h", label: "Every hour" },
                  { value: "2h", label: "Every 2 hours" },
                  { value: "day", label: "Every day" },
                ]}
              />
            }
          />
          <div className="flex flex-col gap-2.5">
            {recentSales.slice(0, 2).map((s) => (
              <TxRow key={s.id} variant="card" leading={<Avatar name={s.name} size="md" />} title={s.name} subtitle={s.when} amount={s.amount} />
            ))}
          </div>
        </Screen>

        <Screen theme="dark" label="Profits · DonutChart, ProgressLegend, recent sales" className="bg-black">
          <SectionHeader
            title="Sales by mode"
            subtitle="Total growth of 26%"
            size="lg"
            action={<IconButton label="Options" icon={<Ellipsis />} tone="outline" shape="square" size="lg" />}
          />
          <div className="flex justify-center py-3">
            <DonutChart label="Sales by mode" data={salesByMode} size={300} />
          </div>
          <ProgressLegend
            items={[
              { label: "Pay now", value: 60, color: "var(--ui-teal)" },
              { label: "Pay in 4", value: 21, color: "var(--ui-pink)" },
              { label: "Subscriptions", value: 19, color: "var(--ui-honey)" },
            ]}
          />
          <SectionHeader title="Recent sales" size="lg" actionLabel="See all" onAction={() => {}} />
          <div className="flex flex-col gap-2.5">
            {recentSales.slice(0, 2).map((s) => (
              <TxRow key={s.id} variant="card" leading={<Avatar name={s.name} size="md" />} title={s.name} subtitle={s.when} amount={s.amount} />
            ))}
          </div>
        </Screen>

        <Screen theme="dark" label="Payouts · CardStack, transactions" className="bg-black">
          <CardStack
            name="Oat & Ember"
            last4="2431"
            meta="AUSD"
            balance={62745}
            deltaLabel="This week"
            delta={11.05}
            actions={[
              { label: "New payout", icon: <Plus strokeWidth={1.5} />, tone: "outline" },
              { label: "Withdraw", icon: <ArrowUpFromLine />, tone: "mint" },
              { label: "Deposit", icon: <ArrowDownToLine />, tone: "honey" },
            ]}
          />
          <SectionHeader title="Transactions" size="lg" actionLabel="Analytics" onAction={() => {}} />
          <div className="flex flex-col gap-2.5">
            <TxRow variant="card" leading={<Avatar name="Priya Shah" size="md" />} title="Priya Shah" subtitle="19 October 15:58" amount={2351} />
            <TxRow variant="card" leading={<Avatar name="Payout" icon={<Wallet />} tone="salmon" size="md" />} title="Payout to wallet" subtitle="21 October 19:20" amount={-5.5} />
            <TxRow variant="card" leading={<Avatar name="Kofi Mensah" size="md" />} title="Kofi Mensah" subtitle="2 minutes ago" amount={61} />
            <TxRow variant="card" leading={<Avatar name="Refund" icon={<ShoppingBag />} tone="honey" size="md" />} title="Refund" subtitle="14 September 12:25" amount={-3.5} />
            <TxRow variant="card" leading={<Avatar name="Store" icon={<Store />} tone="mint" size="md" />} title="Pay in 4 instalment" subtitle="12 October 17:10" amount={15} />
          </div>
        </Screen>
      </Screens>
    </Section>
  );
}


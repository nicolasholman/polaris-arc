"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  Copy,
  Link2,
  Percent,
  Plus,
  RotateCcw,
  Search,
  Users,
  CalendarClock,
  Layers,
} from "lucide-react";
import { useMemo, useState } from "react";

import { BarChart } from "../charts/BarChart";
import { CandlestickChart } from "../charts/CandlestickChart";
import { DonutChart } from "../charts/DonutChart";
import { ProgressLegend } from "../charts/ProgressLegend";
import { CardStack } from "../composites/CardStack";
import { StatCard } from "../composites/StatCard";
import { DetailsList, KeyValueGrid } from "../composites/Stats";
import { TxRow } from "../composites/TxRow";
import { Avatar } from "../primitives/Avatar";
import { Button, IconButton } from "../primitives/Button";
import { Card, SectionHeader, ThemeScope } from "../primitives/Card";
import { EmptyState } from "../primitives/Feedback";
import { Input, Select, Textarea, Toggle } from "../primitives/Field";
import { Logo } from "../primitives/Logo";
import { Money } from "../primitives/Money";
import { Badge, type BadgeTone } from "../primitives/Pill";
import { SegmentedControl, Tab, TabList, Tabs } from "../primitives/Segmented";
import { CellStack, Table, type SortState, type TableColumn } from "../primitives/Table";
import { toast } from "../primitives/Toast";
import { Dialog, Drawer } from "../overlays/Panels";
import { payments, recentSales, salesByMode, salesSpark, volumeCandles, weekCustomers } from "./data";
import { Section } from "./frame";

type Payment = (typeof payments)[number];

const STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  paid: { tone: "lime", label: "Paid" },
  pending: { tone: "neutral", label: "Pending" },
  retrying: { tone: "warn", label: "Retrying" },
  refunded: { tone: "info", label: "Refunded" },
};

/* ── Overlays shared with the Presentation section ───────────────────────── */

export function PaymentDrawer({ payment, onClose }: { payment: Payment | null; onClose: () => void }) {
  const p = payment ?? payments[0]!;
  return (
    <Drawer open={payment !== null} onOpenChange={(o) => !o && onClose()} title="Payment" description={p.id}>
      <Drawer.Body>
        <div className="flex items-center gap-3 pb-5">
          <Avatar name={p.customer} size="lg" />
          <CellStack title={p.customer} sub={p.email} />
        </div>
        <Money value={p.amount} className="text-[44px] leading-none font-semibold tracking-[-0.035em]" />
        <div className="mt-3 flex gap-2">
          <Badge tone={STATUS[p.status]!.tone} dot>
            {STATUS[p.status]!.label}
          </Badge>
          <Badge tone="neutral">{p.mode}</Badge>
        </div>
        <KeyValueGrid
          className="mt-6"
          items={[
            { label: "Amount", value: `$${p.amount.toFixed(2)}` },
            { label: "Fee", value: `$${(p.amount * 0.012).toFixed(2)}` },
            { label: "Net", value: `$${(p.amount * 0.988).toFixed(2)}` },
            { label: "Settled", value: "Under a second" },
          ]}
        />
        <DetailsList
          className="mt-4"
          size="sm"
          items={[
            { label: "Created", value: p.date },
            { label: "Link", value: "Spring menu" },
            { label: "Customer", value: p.email },
            { label: "Reference", value: p.id },
          ]}
        />
      </Drawer.Body>
      <Drawer.Footer>
        <Button variant="outline" icon={<RotateCcw />} onClick={() => toast({ title: "Refund started", description: `$${p.amount.toFixed(2)} back to ${p.customer}` })}>
          Refund
        </Button>
        <Button variant="dark" icon={<Copy />} onClick={() => toast({ title: "Receipt link copied", tone: "success" })}>
          Copy receipt
        </Button>
      </Drawer.Footer>
    </Drawer>
  );
}

export function NewLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [mode, setMode] = useState("any");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New payment link" description="Share it anywhere. Customers pay in full, in four, or monthly.">
      <Dialog.Body className="flex flex-col gap-4">
        <Input label="Name" placeholder="Spring menu" defaultValue="Spring menu" />
        <Input label="Price" placeholder="0.00" inputMode="decimal" icon={<span className="text-[15px] font-medium">$</span>} trailing="USD" defaultValue="48.00" />
        <div className="flex flex-col gap-2">
          <span className="text-[14px] font-medium text-ui-muted">How customers can pay</span>
          <SegmentedControl
            aria-label="How customers can pay"
            block
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "any", label: "Any way" },
              { value: "now", label: "Pay now" },
              { value: "four", label: "Pay in 4" },
            ]}
          />
        </div>
        <Select
          label="Payout wallet"
          variant="filled"
          defaultValue="main"
          options={[
            { value: "main", label: "Main wallet", description: "0x7a3f…91c2" },
            { value: "ops", label: "Operations", description: "0x19b0…4e7d" },
          ]}
        />
        <Textarea label="Note for the customer" placeholder="Thanks for your order!" rows={2} />
        <Toggle label="Collect a shipping address" description="Asked at checkout" defaultChecked />
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="dark"
          icon={<Link2 />}
          onClick={() => {
            onOpenChange(false);
            toast({ title: "Link created", description: "polaris.link/oat-ember/spring-menu", tone: "success", action: { label: "Copy", onClick: () => {} } });
          }}
        >
          Create link
        </Button>
      </Dialog.Footer>
    </Dialog>
  );
}

/* ── The dashboard preview ───────────────────────────────────────────────── */

export function SectionWeb() {
  const [page, setPage] = useState("overview");
  const [filter, setFilter] = useState("all");
  const [tf, setTf] = useState("1M");
  const [open, setOpen] = useState<Payment | null>(null);
  const [newLink, setNewLink] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: "date", dir: "desc" });
  const [query, setQuery] = useState("");
  const [auto, setAuto] = useState(true);

  const rows = useMemo(() => {
    let r = payments.filter((p) => (filter === "all" ? true : p.status === filter));
    if (query) r = r.filter((p) => `${p.customer} ${p.email} ${p.id}`.toLowerCase().includes(query.toLowerCase()));
    if (sort?.key === "amount") r = [...r].sort((a, b) => (sort.dir === "asc" ? a.amount - b.amount : b.amount - a.amount));
    if (sort?.key === "date") r = sort.dir === "asc" ? [...r].reverse() : r;
    return r;
  }, [filter, query, sort]);

  const columns: TableColumn<Payment>[] = [
    {
      key: "customer",
      header: "Customer",
      render: (p) => (
        <div className="flex max-w-[150px] items-center gap-3 sm:max-w-none">
          <Avatar name={p.customer} size="sm" decorative />
          <CellStack title={p.customer} sub={p.email} />
        </div>
      ),
    },
    { key: "mode", header: "Mode", hideBelow: "md", render: (p) => <Badge tone="neutral">{p.mode}</Badge> },
    {
      key: "status",
      header: "Status",
      render: (p) => (
        <Badge tone={STATUS[p.status]!.tone} dot>
          {STATUS[p.status]!.label}
        </Badge>
      ),
    },
    { key: "date", header: "Date", sortable: true, hideBelow: "lg", render: (p) => <span className="text-ui-muted">{p.date}</span> },
    { key: "amount", header: "Amount", align: "right", sortable: true, render: (p) => <Money value={p.amount} dim="none" className="font-medium" /> },
  ];

  const counts = {
    all: payments.length,
    paid: payments.filter((p) => p.status === "paid").length,
    pending: payments.filter((p) => p.status === "pending").length,
    refunded: payments.filter((p) => p.status === "refunded").length,
  };

  return (
    <Section
      id="web"
      eyebrow="Web dashboard"
      title="The merchant dashboard, dark like the app"
      description="Ref C's layout and density on the app's dark ground, with ref D's panels: the sales cards, customers this week, sales by mode, daily volume candles, recent sales, the payments table (rows open a Drawer), a new-link Dialog, and the payouts card."
    >
      <ThemeScope theme="dark" className="overflow-hidden rounded-[32px] bg-ui-canvas p-3 ring-1 ring-white/5 md:rounded-[40px] md:p-6">
        {/* top bar */}
        <div className="flex flex-wrap items-center gap-3 rounded-full bg-ui-surface-1 p-2 pl-5 shadow-ui-card">
          <Logo height={28} />
          <div className="order-3 w-full md:order-none md:ml-4 md:w-auto md:flex-1">
            <Tabs value={page} onValueChange={setPage} variant="pill" size="md">
              <TabList aria-label="Dashboard">
                <Tab value="overview">Overview</Tab>
                <Tab value="payments">Payments</Tab>
                <Tab value="links">Links</Tab>
                <Tab value="plans">Plans</Tab>
                <Tab value="payouts">Payouts</Tab>
                <Tab value="developers">Developers</Tab>
              </TabList>
            </Tabs>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Input hideLabel label="Search" placeholder="Search" icon={<Search />} wrapperClassName="hidden w-[220px] lg:flex" className="h-10" />
            <IconButton label="Notifications" icon={<Bell />} tone="surface" dot />
            <Avatar name="Oat & Ember" tone="honey" size="md" />
          </div>
        </div>

        {/* headline */}
        <div className="mt-6 flex flex-wrap items-end justify-between gap-4 px-1 md:mt-8">
          <div>
            <p className="text-[14px] text-ui-muted">Good morning, Oat & Ember</p>
            <h3 className="mt-1 text-[30px] leading-tight font-medium tracking-[-0.03em] md:text-[36px]">Overview</h3>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" icon={<ArrowUpFromLine />}>
              Pay out
            </Button>
            <Button variant="dark" icon={<Plus />} onClick={() => setNewLink(true)}>
              New link
            </Button>
          </div>
        </div>

        {/* stat cards */}
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard tone="sage" icon={<Percent />} label="Sales" delta={23} value={<Money value={24575} decimals={0} spaced dim="none" />} spark={salesSpark} />
          <StatCard
            tone="pink"
            icon={<Layers />}
            label="Pay in 4"
            delta={12}
            value={<Money value={19839} decimals={0} spaced dim="none" />}
            spark={[8, 9, 8.5, 10, 11, 9.8, 12, 11.5, 12.8, 12.2, 13.9, 14.2]}
          />
          <StatCard
            tone="honey"
            icon={<CalendarClock />}
            label="Subscriptions"
            delta={-4}
            value={<Money value={17950} decimals={0} spaced dim="none" />}
            spark={[14, 13.5, 14.2, 13.1, 12.8, 13.2, 12.4, 12.9, 12.1, 12.5]}
          />
          <StatCard
            tone="surface"
            icon={<Users />}
            label="Customers"
            delta={2.1}
            value={<span className="ui-figure">1,284</span>}
            spark={[3, 4, 3.6, 5, 4.4, 5.6, 5.1, 6.2, 5.8, 6.9]}
          />
        </div>

        {/* analytics */}
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
          <Card theme="dark" padding="lg" className="xl:col-span-5">
            <SectionHeader title="Customers this week" size="lg" actionLabel="See all" onAction={() => {}} />
            <div className="ui-figure mt-2 text-[40px] leading-none font-bold tracking-[-0.03em]">+ 2.1%</div>
            <BarChart className="mt-7" label="Customers this week" data={weekCustomers} height={190} formatValue={(v) => `$ ${v.toLocaleString("en-US")}`} />
          </Card>
          <Card theme="dark" padding="lg" className="xl:col-span-7">
            <SectionHeader title="Sales by mode" subtitle="Total growth of 26%" size="lg" />
            <div className="mt-4 flex flex-col items-center gap-8 md:flex-row md:items-center">
              <DonutChart label="Sales by mode" data={salesByMode} size={280} />
              <div className="w-full min-w-0 flex-1">
                <ProgressLegend
                  direction="column"
                  items={[
                    { label: "Pay now", value: 60, color: "var(--ui-teal)" },
                    { label: "Pay in 4", value: 21, color: "var(--ui-pink)" },
                    { label: "Subscriptions", value: 19, color: "var(--ui-honey)" },
                  ]}
                />
              </div>
            </div>
          </Card>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
          <div className="xl:col-span-8">
            <CandlestickChart
              label="Daily payment volume, thousands of dollars"
              data={volumeCandles}
              height={380}
              reference={{ value: 97.45 }}
              timeframes={["1D", "1W", "1M", "3M"]}
              timeframe={tf}
              onTimeframeChange={setTf}
              onTypeToggle={() => {}}
              leading={<span className="hidden px-2 text-[15px] font-medium whitespace-nowrap sm:inline">Daily volume ($K)</span>}
              className="rounded-ui-card"
            />
          </div>
          <Card theme="dark" padding="lg" className="xl:col-span-4">
            <SectionHeader title="Recent sales" size="lg" actionLabel="See all" onAction={() => {}} />
            <div className="mt-4 flex flex-col gap-2.5">
              {recentSales.map((s) => (
                <TxRow key={s.id} variant="card" leading={<Avatar name={s.name} size="md" />} title={s.name} subtitle={s.when} amount={s.amount} onClick={() => {}} />
              ))}
            </div>
          </Card>
        </div>

        {/* payments table */}
        <Card padding="none" className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 md:px-6">
            <SectionHeader title="Payments" size="lg" />
            <div className="flex flex-wrap items-center gap-2">
              <Input
                hideLabel
                label="Search payments"
                placeholder="Search payments"
                icon={<Search />}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                wrapperClassName="w-full sm:w-[240px]"
                className="h-10"
              />
              <Select
                aria-label="Period"
                variant="outline"
                defaultValue="30d"
                options={[
                  { value: "7d", label: "Last 7 days" },
                  { value: "30d", label: "Last 30 days" },
                  { value: "90d", label: "Last 90 days" },
                ]}
              />
              <Button variant="outline" icon={<ArrowDownToLine />} size="md">
                Export
              </Button>
            </div>
          </div>
          <Tabs value={filter} onValueChange={setFilter} variant="pill" className="mt-4 px-4 md:px-5">
            <TabList aria-label="Filter payments">
              <Tab value="all" count={counts.all}>
                All
              </Tab>
              <Tab value="paid" count={counts.paid}>
                Paid
              </Tab>
              <Tab value="pending" count={counts.pending}>
                Pending
              </Tab>
              <Tab value="refunded" count={counts.refunded}>
                Refunded
              </Tab>
            </TabList>
          </Tabs>
          <Table
            className="mt-3 pb-2"
            caption="Payments"
            columns={columns}
            rows={rows}
            rowKey={(p) => p.id}
            onRowClick={(p) => setOpen(p)}
            selectedKey={open?.id}
            sort={sort}
            onSortChange={setSort}
            empty={<EmptyState size="sm" icon={<Search />} title="No payments match" description="Try another name, email or payment ID." />}
          />
        </Card>

        {/* payouts */}
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
          <Card theme="dark" padding="lg" className="xl:col-span-5">
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
          </Card>
          <Card padding="lg" className="xl:col-span-4">
            <SectionHeader title="Payout settings" size="lg" />
            <Toggle className="mt-5" label="Automatic payouts" description="Every day at 17:00 to your main wallet" checked={auto} onCheckedChange={setAuto} />
            <DetailsList
              className="mt-5"
              variant="sunken"
              size="sm"
              items={[
                { label: "Wallet", value: "0x7a3f…91c2" },
                { label: "Next payout", value: "Today, 17:00" },
                { label: "Minimum", value: "$50.00" },
              ]}
            />
          </Card>
          <Card padding="none" className="xl:col-span-3">
            <EmptyState
              icon={<Link2 />}
              title="No subscriptions yet"
              description="Turn any link into a monthly plan and it shows up here."
              action={
                <Button variant="dark" size="sm" icon={<Plus />} onClick={() => setNewLink(true)}>
                  New link
                </Button>
              }
            />
          </Card>
        </div>
      </ThemeScope>

      <PaymentDrawer payment={open} onClose={() => setOpen(null)} />
      <NewLinkDialog open={newLink} onOpenChange={setNewLink} />
    </Section>
  );
}

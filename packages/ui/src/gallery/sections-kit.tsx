"use client";

import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  ChevronLeft,
  Ellipsis,
  Gift,
  Inbox,
  CandlestickChart,
  LineChart,
  Mail,
  Plus,
  Search,
  Share2,
  SlidersHorizontal,
  Repeat,
  ScanFace,
  QrCode,
  Smartphone,
  Copy,
  Check,
  LogOut,
} from "lucide-react";
import { useState } from "react";

import { Sparkline } from "../charts/Sparkline";
import { TxRow } from "../composites/TxRow";
import { Avatar, AvatarStack, FlagBadge } from "../primitives/Avatar";
import { Button, IconButton, type ButtonVariant } from "../primitives/Button";
import { Card, RowChevron, SectionHeader, ThemeScope, Tile, type Theme } from "../primitives/Card";
import { EmptyState, IconDisc, Skeleton, SkeletonText } from "../primitives/Feedback";
import { Input, Select, Toggle } from "../primitives/Field";
import { Logo, LogoMark } from "../primitives/Logo";
import { ScanFrame } from "../primitives/ScanFrame";
import { Money } from "../primitives/Money";
import { Badge, Chip, DeltaBadge, Pill } from "../primitives/Pill";
import { RangeTabs, SegmentedControl, Tab, TabList, Tabs } from "../primitives/Segmented";
import { toast } from "../primitives/Toast";
import { SuccessCheck } from "../primitives/SuccessCheck";
import { DetailsList } from "../composites/Stats";
import { ListGroup, ListRow } from "../composites/ListRow";
import { BottomSheet, Sheet, type SnapPoint } from "../overlays/BottomSheet";
import { Dialog } from "../overlays/Panels";
import { people, payments } from "./data";
import { Section, Specimen } from "./frame";
import { NewLinkDialog, PaymentDrawer } from "./sections-web";

/* ── Foundations ─────────────────────────────────────────────────────────── */

const SURFACES = ["canvas", "surface-1", "surface-2", "surface-3", "ink", "track"];
const TEXTS = ["text", "muted", "dim", "up", "down", "purple-text"];
const BRAND = ["lime", "lime-bright", "lime-logo", "purple", "purple-deep", "crimson-from", "purple-chart-from"];
const PASTELS = ["blue", "yellow", "lilac", "salmon", "cyan", "mint", "teal", "pink", "sage", "sky", "honey", "mint-soft"];

function Swatch({ name }: { name: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="h-14 rounded-[14px] ring-1 ring-ui-hairline" style={{ background: `var(--ui-${name})` }} />
      <span className="truncate text-[12px] text-ui-muted">{name}</span>
    </div>
  );
}

function ThemeTokens({ theme }: { theme: Theme }) {
  return (
    <ThemeScope theme={theme} className="rounded-ui-card bg-ui-canvas p-5 ring-1 ring-ui-hairline md:p-6">
      <p className="text-[15px] font-medium">{theme === "dark" ? "Dark (default)" : "Light · data-theme=\"light\""}</p>
      <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
        {SURFACES.map((s) => (
          <Swatch key={s} name={s} />
        ))}
      </div>
      <div className="mt-5 grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-6">
        {TEXTS.map((t) => (
          <span key={t} className="text-[15px] font-medium" style={{ color: `var(--ui-${t})` }}>
            {t}
          </span>
        ))}
      </div>
    </ThemeScope>
  );
}

export function SectionFoundations() {
  return (
    <Section
      id="foundations"
      eyebrow="Foundations"
      title="Tokens, type and shape"
      description={
        <>
          Satoshi Variable for everything, tabular figures, the dim-dollar <code className="text-ui-text">Money</code>. Two themes on
          the same token names; brand accents and the chart pastels are shared.
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ThemeTokens theme="dark" />
        <ThemeTokens theme="light" />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card padding="lg" className="ring-1 ring-ui-hairline">
          <p className="text-[15px] font-medium">Brand and accents</p>
          <div className="mt-4 grid grid-cols-4 gap-3 sm:grid-cols-7">
            {BRAND.map((s) => (
              <Swatch key={s} name={s} />
            ))}
          </div>
          <p className="mt-6 text-[15px] font-medium">Chart pastels</p>
          <div className="mt-4 grid grid-cols-4 gap-3 sm:grid-cols-6">
            {PASTELS.map((s) => (
              <Swatch key={s} name={s} />
            ))}
          </div>
        </Card>
        <Card padding="lg" className="ring-1 ring-ui-hairline">
          <p className="text-[15px] font-medium">Type · Satoshi</p>
          <div className="mt-4 flex flex-col gap-3">
            <Money value={25841.11} dim="symbol" className="text-[56px] leading-none font-semibold tracking-[-0.04em]" />
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <Money value={81590.9} dim="cents" className="text-[40px] leading-none font-bold tracking-[-0.03em]" />
              <Money value={24575} decimals={0} spaced dim="none" className="text-[40px] leading-none font-bold tracking-[-0.03em]" />
              <Money value={-15} signed dim="none" className="text-[20px] font-medium" />
              <Money value={37847} compact className="text-[20px] font-medium" />
            </div>
            <p className="text-[22px] font-medium tracking-[-0.02em]">Section title, 22 medium</p>
            <p className="text-[16px] font-medium">Row title, 16 medium · 0123456789</p>
            <p className="text-[14px] text-ui-muted">Labels and meta, 14 regular in muted</p>
          </div>
          <p className="mt-6 text-[15px] font-medium">Radius</p>
          <div className="mt-3 flex flex-wrap items-end gap-3 text-[12px] text-ui-muted">
            {[
              ["card", "28", "rounded-ui-card size-20"],
              ["tile", "20", "rounded-ui-tile size-16"],
              ["row", "18", "rounded-ui-row size-14"],
              ["key", "22", "rounded-ui-key h-14 w-20"],
              ["sheet", "32", "rounded-t-ui-sheet h-16 w-24"],
            ].map(([n, v, c]) => (
              <span key={n} className="flex flex-col items-center gap-1.5">
                <span className={`${c} bg-ui-surface-3`} />
                {n} {v}
              </span>
            ))}
          </div>
          <p className="mt-6 text-[15px] font-medium">Logo</p>
          <div className="mt-3 flex items-center gap-5">
            <Logo height={36} />
            <LogoMark size={36} />
          </div>
        </Card>
      </div>
    </Section>
  );
}

/* ── Controls, in both themes ────────────────────────────────────────────── */

const VARIANTS: ButtonVariant[] = ["lime", "lime-bright", "white", "dark", "purple", "violet", "outline", "ghost"];

function Controls({ theme }: { theme: Theme }) {
  const [seg, setSeg] = useState("now");
  const [range, setRange] = useState("1W");
  const [chip, setChip] = useState("all");
  const [on, setOn] = useState(true);
  const [loading, setLoading] = useState(false);
  return (
    <ThemeScope theme={theme} className="flex min-w-0 flex-col gap-7 rounded-ui-card bg-ui-canvas p-5 ring-1 ring-ui-hairline md:p-7">
      <p className="text-[15px] font-medium">{theme === "dark" ? "Dark" : "Light"}</p>

      <Specimen label="Button · variants">
        {VARIANTS.map((v) => (
          <Button key={v} variant={v}>
            {v}
          </Button>
        ))}
      </Specimen>
      <Specimen label="Button · sizes, rounded, icons, loading, disabled">
        <Button variant="lime" size="sm">
          Small
        </Button>
        <Button variant="lime" size="md" icon={<Plus />}>
          Medium
        </Button>
        <Button variant="dark" size="lg" iconRight={<ArrowRight />}>
          Large
        </Button>
        <Button variant="white" size="lg" shape="rounded">
          Rounded
        </Button>
        <Button
          variant="purple"
          loading={loading}
          onClick={() => {
            setLoading(true);
            setTimeout(() => setLoading(false), 1600);
          }}
        >
          Press to load
        </Button>
        <Button variant="lime" disabled>
          Disabled
        </Button>
      </Specimen>
      <Specimen label="Button · xl block (ref A Send)">
        <Button variant="lime" size="xl" block>
          Send
        </Button>
      </Specimen>

      <Specimen label="IconButton · tones, round and square, sizes, dot">
        <IconButton label="Notifications" icon={<Bell />} tone="surface" dot />
        <IconButton label="Share" icon={<Share2 />} tone="ink" />
        <IconButton label="Options" icon={<Ellipsis />} tone="outline" shape="square" size="lg" />
        <IconButton label="Line" icon={<LineChart />} tone="white" shape="square" />
        <IconButton label="Add" icon={<Plus />} tone="lime" />
        <IconButton label="Scan" icon={<QrCode />} tone="purple" />
        <IconButton label="Back" icon={<ChevronLeft />} tone="ghost" />
        <IconButton label="Back" icon={<ChevronLeft />} tone="surface" shape="square" />
        <IconButton label="Filter" icon={<SlidersHorizontal />} tone="black" size="sm" />
        <IconButton label="Calendar" icon={<CalendarDays />} tone="surface" size="lg" />
      </Specimen>

      <Specimen label="Pill">
        <Pill tone="black" chevron onClick={() => {}}>
          Main account
        </Pill>
        <Pill tone="ink" icon={<Gift />}>
          Rewards
        </Pill>
        <Pill tone="white" chevron onClick={() => {}}>
          Market
        </Pill>
        <Pill tone="surface" size="sm">
          USD · AUSD
        </Pill>
        <Pill tone="outline" icon={<Repeat />}>
          Monthly
        </Pill>
        <Pill tone="lime" size="sm">
          Business
        </Pill>
      </Specimen>

      <Specimen label="Chip · plain, outline, solid, counts">
        <div className="flex items-center">
          {["5m", "15m", "30m", "5h"].map((t) => (
            <Chip key={t} selected={t === "5h"}>
              {t}
            </Chip>
          ))}
        </div>
        {[
          ["all", "All", 24],
          ["paid", "Paid", 18],
          ["late", "Late", 2],
        ].map(([k, l, n]) => (
          <Chip key={k as string} variant="outline" selected={chip === k} count={n as number} onClick={() => setChip(k as string)}>
            {l}
          </Chip>
        ))}
        <Chip variant="solid" selected>
          Pay in 4
        </Chip>
        <Chip variant="solid">Pay now</Chip>
      </Specimen>

      <Specimen label="DeltaBadge · text, soft, note, chip on colour">
        <DeltaBadge value={3.25} />
        <DeltaBadge value={-6.34} />
        <DeltaBadge value={2.1} variant="soft" />
        <DeltaBadge value={-1.2} variant="soft" />
        <DeltaBadge value={10.08} note="From last week" />
        <span className="rounded-[14px] bg-[#e93158] p-2 text-white">
          <DeltaBadge value={1.76} amount="$1,205.50" variant="chip" />
        </span>
        <span className="rounded-[14px] bg-ui-sage p-2 text-[#13141f]">
          <DeltaBadge value={23} decimals={0} variant="chip" size="sm" />
        </span>
      </Specimen>

      <Specimen label="Badge · status">
        <Badge tone="up" dot>
          Paid
        </Badge>
        <Badge tone="neutral" dot>
          Pending
        </Badge>
        <Badge tone="warn" dot>
          Retrying
        </Badge>
        <Badge tone="down" dot>
          Written off
        </Badge>
        <Badge tone="purple">Refunded</Badge>
        <Badge tone="lime">Live</Badge>
        <Badge tone="info">Test mode</Badge>
        <Badge tone="ink" size="sm">
          New
        </Badge>
      </Specimen>

      <Specimen label="Avatar · sizes, brand circle, flag, stack">
        <Avatar name="Ana Ruiz" size="xs" />
        <Avatar name="Kofi Mensah" size="sm" />
        <Avatar name="Priya Shah" size="md" badge={<FlagBadge code="IN" size={16} />} />
        <Avatar name="Leo Park" size="lg" badge={<FlagBadge code="US" size={18} />} />
        <Avatar name="Oat & Ember" size="xl" color="#c2410c" />
        <AvatarStack people={people} max={4} />
        <span className="flex gap-1.5">
          {(["US", "EU", "GB", "IN", "NG", "MX", "BR", "CA"] as const).map((c) => (
            <FlagBadge key={c} code={c} size={22} ring={false} />
          ))}
        </span>
      </Specimen>

      <Specimen label="Card, Tile, SectionHeader, RowChevron">
        <Card variant="raised" padding="md" className="w-full max-w-[300px]">
          <SectionHeader title="Recent sales" actionLabel="See all" onAction={() => {}} />
          <Tile className="mt-3 flex items-center justify-between py-3.5">
            <span className="text-[15px] font-medium">Payouts</span>
            <RowChevron />
          </Tile>
        </Card>
        <Card variant="outline" radius="tile" padding="md" className="w-full max-w-[220px]">
          <p className="text-[15px] font-medium">Outline card</p>
          <p className="mt-1 text-[13px] text-ui-muted">A hairline, no fill</p>
        </Card>
      </Specimen>

      <Specimen label="SegmentedControl · rounded (ref B), pill, sm">
        <SegmentedControl
          aria-label="Order"
          value={seg}
          onValueChange={setSeg}
          options={[
            { value: "now", label: "Market" },
            { value: "limit", label: "Limit" },
          ]}
        />
        <SegmentedControl
          aria-label="Pay"
          shape="pill"
          defaultValue="four"
          options={[
            { value: "now", label: "Pay now" },
            { value: "four", label: "Pay in 4" },
            { value: "month", label: "Monthly" },
          ]}
        />
        <SegmentedControl
          aria-label="View"
          size="sm"
          defaultValue="w"
          options={[
            { value: "d", label: "Day" },
            { value: "w", label: "Week" },
            { value: "m", label: "Month" },
          ]}
        />
        <div className="rounded-[18px] bg-[#8a31c6] p-3">
          <SegmentedControl
            variant="icon"
            aria-label="Chart type"
            defaultValue="line"
            options={[
              { value: "line", label: "Line", icon: <LineChart /> },
              { value: "candles", label: "Candles", icon: <CandlestickChart /> },
            ]}
          />
        </div>
      </Specimen>

      <Specimen label="Tabs · text (ref A), pill, segmented">
        <Tabs defaultValue="expenses" variant="text">
          <TabList aria-label="Text tabs">
            <Tab value="expenses">Expenses</Tab>
            <Tab value="plans">Plans</Tab>
          </TabList>
        </Tabs>
        <Tabs defaultValue="all" variant="pill">
          <TabList aria-label="Pill tabs">
            <Tab value="all" count={24}>
              All
            </Tab>
            <Tab value="paid">Paid</Tab>
            <Tab value="refunded">Refunded</Tab>
          </TabList>
        </Tabs>
        <Tabs defaultValue="keys" variant="segmented">
          <TabList aria-label="Segmented tabs">
            <Tab value="keys">API keys</Tab>
            <Tab value="hooks">Webhooks</Tab>
          </TabList>
        </Tabs>
      </Specimen>

      <Specimen label="RangeTabs · on a surface" className="max-w-[420px]">
        <RangeTabs tone="surface" value={range} onValueChange={setRange} onCalendar={() => {}} className="w-full" />
      </Specimen>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Business name" placeholder="Acme Coffee" defaultValue="Oat & Ember" />
        <Input label="Email" placeholder="you@business.com" icon={<Mail />} error="Enter a valid email" defaultValue="hello@" />
        <Input label="Search" hideLabel placeholder="Search payments" icon={<Search />} variant="outline" />
        <Input label="Amount" placeholder="0.00" trailing="USD" hint="Customers see this price" inputMode="decimal" />
      </div>

      <Specimen label="Select · outline (ref D), white (ref C), chip, filled">
        <Select
          aria-label="Refresh"
          variant="outline"
          defaultValue="2h"
          options={[
            { value: "1h", label: "Every hour" },
            { value: "2h", label: "Every 2 hours" },
            { value: "d", label: "Every day" },
          ]}
        />
        <Select
          aria-label="Order type"
          variant="white"
          defaultValue="market"
          options={[
            { value: "market", label: "Market" },
            { value: "limit", label: "Limit" },
          ]}
        />
        <span className="rounded-full bg-ui-candle-panel p-1.5">
          <Select
            aria-label="Metric"
            variant="chip"
            size="sm"
            defaultValue="price"
            options={[
              { value: "price", label: "Price" },
              { value: "count", label: "Count" },
            ]}
            className="h-9"
          />
        </span>
        <Select
          label="Payout wallet"
          variant="filled"
          placeholder="Choose a wallet"
          wrapperClassName="w-full sm:w-[260px]"
          options={[
            { value: "main", label: "Main wallet", description: "0x7a3f…91c2" },
            { value: "ops", label: "Operations", description: "0x19b0…4e7d" },
            { value: "old", label: "Old wallet", description: "Retired", disabled: true },
          ]}
        />
      </Specimen>

      <div className="flex flex-col gap-4">
        <Toggle label="Automatic payouts" description="Every day at 17:00" checked={on} onCheckedChange={setOn} />
        <Toggle label="Test mode" size="sm" />
      </div>

      <Specimen label="Money">
        <Money value={1284.5} className="text-[28px] font-semibold" />
        <Money value={1284.5} dim="symbol" className="text-[28px] font-semibold" />
        <Money value={1284.5} dim="cents" className="text-[28px] font-semibold" />
        <Money value={-59} signed dim="none" className="text-[18px] text-ui-down" />
        <Money value={2351} signed dim="none" className="text-[18px] text-ui-up" />
      </Specimen>

      <Specimen label="Sparkline">
        <Sparkline data={[4, 6, 5, 8, 7, 9, 8, 11]} color="var(--ui-up)" width={96} height={32} />
        <Sparkline data={[11, 9, 10, 7, 8, 6, 7, 4]} color="var(--ui-down)" width={96} height={32} />
        <Sparkline data={[4, 7, 5, 8, 6, 9, 7, 10, 9, 12]} color="var(--ui-purple-deep)" width={96} height={32} fill />
        <Sparkline data={[5, 8, 6, 9, 5, 10, 7, 6, 9]} width={120} height={36} curve="linear" baseline="avg" strokeWidth={2} />
      </Specimen>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card variant="raised" padding="md" className="flex flex-col gap-3">
          <p className="text-[13px] font-medium text-ui-muted">Skeleton</p>
          <div className="flex items-center gap-3">
            <Skeleton shape="circle" width={44} height={44} />
            <div className="flex-1">
              <SkeletonText lines={2} />
            </div>
          </div>
          <Skeleton shape="tile" height={64} />
        </Card>
        {/* Outline, not raised: the discs are surface-2, like a raised card. */}
        <Card variant="outline" className="flex flex-col gap-4">
          <p className="text-[13px] font-medium text-ui-muted">IconDisc · sm, md, lg</p>
          <div className="flex items-center gap-3">
            <IconDisc size="sm" icon={<Inbox />} />
            <IconDisc size="md" icon={<Smartphone />} />
            <IconDisc icon={<ScanFace />} />
          </div>
          <p className="text-[13px] font-medium text-ui-muted">ScanFrame</p>
          <ScanFrame>
            <p className="absolute inset-0 grid place-items-center px-10 text-center text-[14px] text-ui-muted">The camera shows here</p>
          </ScanFrame>
        </Card>
        <Card variant="raised" padding="none">
          <EmptyState
            size="sm"
            icon={<Inbox />}
            title="No payments yet"
            description="Share a link and the first one lands here."
            action={
              <Button size="sm" variant="dark" icon={<Plus />}>
                New link
              </Button>
            }
          />
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ListGroup label="ListRow · in a ListGroup">
          <ListRow icon={<Bell />} title="Notifications" description="Payments due and money in" onClick={() => {}} />
          <ListRow icon={<ScanFace />} title="Face ID" description="Asked for every payment" trailing={<Badge tone="up">On</Badge>} />
          <ListRow icon={<Mail />} title="Name on links" trailing="Lena Vogel" onClick={() => {}} />
          <ListRow icon={<LogOut />} tone="down" title="Log out" onClick={() => {}} chevron={false} />
        </ListGroup>
        <div className="flex flex-col gap-2">
          <p className="mb-0 px-1 text-[14px] font-medium text-ui-muted">ListRow · card (ref D)</p>
          <ListRow variant="card" icon={<Repeat />} tone="purple" title="Figura Pro renews" description="$12.00 on Oct 9" trailing="2h" />
          <ListRow variant="card" icon={<Check />} tone="lime" title="Marisol claimed your link" description="$50.00 arrived" trailing="1d" />
        </div>
      </div>

      <Specimen label="Toast">
        <Button variant="outline" size="sm" icon={<Check />} onClick={() => toast({ title: "Link copied", tone: "success" })}>
          Success
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast({ title: "Payout sent", description: "$1,240.00 to 0x7a3f…91c2", action: { label: "View", onClick: () => {} } })}
        >
          With action
        </Button>
        <Button variant="outline" size="sm" onClick={() => toast({ title: "Card declined", description: "Try another way to pay.", tone: "error" })}>
          Error
        </Button>
        <Button variant="outline" size="sm" onClick={() => toast({ title: "Test mode is on", tone: "info" })}>
          Info
        </Button>
      </Specimen>
    </ThemeScope>
  );
}

export function SectionControls() {
  return (
    <Section
      id="controls"
      eyebrow="Primitives"
      title="Every control, in both themes"
      description="Buttons, icon buttons, pills, chips, deltas, badges, avatars and flags, segmented controls, tabs, range tabs, fields, selects, toggles, money, sparklines, skeletons, empty states and toasts."
    >
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <Controls theme="light" />
        <Controls theme="dark" />
      </div>
    </Section>
  );
}

/* ── Presentation ────────────────────────────────────────────────────────── */

type Demo = { key: string; label: string; snaps: SnapPoint[]; title: string };

const DEMOS: Demo[] = [
  { key: "faceid", label: "Compact · Confirm with Face ID", snaps: ["compact"], title: "Confirm payment" },
  { key: "faceid-fit", label: "Fit · the same, hugging its content", snaps: ["fit"], title: "Confirm payment" },
  { key: "success", label: "Half · Success receipt", snaps: ["half"], title: "Receipt" },
  { key: "receive", label: "Half · Receive", snaps: ["half"], title: "Receive" },
  { key: "plan", label: "Half, drag to full · Plan", snaps: ["half", "full"], title: "Oat & Ember plan" },
  { key: "send", label: "Full · Send", snaps: ["full"], title: "Send" },
];

export function SectionPresentation() {
  const [sheet, setSheet] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const active = DEMOS.find((d) => d.key === sheet);

  return (
    <Section
      id="presentation"
      eyebrow="Presentation"
      title="Sheets, drawers and dialogs"
      description="Everything you do slides up as a BottomSheet: snap points (compact, half, full, or fit to the content), drag with a velocity-based dismiss, a sheet over a sheet stacking with its own backdrop, a dimmed and blurred backdrop, the page behind scaled to 0.96 with rounded corners, a focus trap, Escape and a scroll lock. On the web, details open in a right-hand Drawer and create flows in a centred Dialog; below 768px both become sheets."
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card padding="lg" className="flex flex-col gap-3 ring-1 ring-ui-hairline">
          <p className="text-[15px] font-medium">BottomSheet</p>
          {DEMOS.map((d) => (
            <Button key={d.key} variant="outline" block className="justify-between" iconRight={<ArrowUpRight />} onClick={() => setSheet(d.key)}>
              {d.label}
            </Button>
          ))}
        </Card>
        <Card padding="lg" className="flex flex-col gap-3 ring-1 ring-ui-hairline">
          <p className="text-[15px] font-medium">Drawer · payment detail</p>
          <p className="text-[14px] text-ui-muted">Right-hand panel on desktop; a half sheet that drags to full below 768px.</p>
          <Button variant="dark" onClick={() => setDrawer(true)} className="mt-auto">
            Open payment
          </Button>
        </Card>
        <Card padding="lg" className="flex flex-col gap-3 ring-1 ring-ui-hairline">
          <p className="text-[15px] font-medium">Dialog · create and confirm</p>
          <p className="text-[14px] text-ui-muted">Centred on desktop; a full sheet (or compact for small dialogs) below 768px.</p>
          <div className="mt-auto flex flex-wrap gap-2">
            <Button variant="dark" onClick={() => setDialog(true)}>
              New payment link
            </Button>
            <Button variant="outline" onClick={() => setConfirm(true)}>
              Revoke key
            </Button>
          </div>
        </Card>
      </div>

      <BottomSheet
        open={active !== undefined}
        onOpenChange={(o) => !o && setSheet(null)}
        snapPoints={active?.snaps ?? ["half"]}
        title={active?.title}
        description={active?.key === "plan" ? "Pay in 4 · 2 of 4 paid" : undefined}
      >
        {active?.key === "faceid" || active?.key === "faceid-fit" ? (
          <Sheet.Body className="flex flex-col items-center gap-4 pt-2 text-center">
            <span className="grid size-16 place-items-center rounded-full bg-ui-surface-2">
              <ScanFace aria-hidden size={30} strokeWidth={1.5} />
            </span>
            <p className="text-[15px] text-ui-muted">
              Pay <span className="text-ui-text">$32.02</span> to Oat & Ember now, then three more every two weeks.
            </p>
            <Button variant="lime" size="lg" block onClick={() => setSheet(null)}>
              Confirm with Face ID
            </Button>
          </Sheet.Body>
        ) : active?.key === "success" ? (
          <>
            <Sheet.Body className="flex flex-col items-center gap-3 pt-2 text-center">
              <SuccessCheck label="Paid" />
              <p className="mt-2 text-[34px] leading-none font-semibold tracking-[-0.03em]">Paid.</p>
              <p className="text-[15px] text-ui-muted">$32.02 to Oat &amp; Ember. Next payment in two weeks.</p>
              <DetailsList
                size="sm"
                className="mt-2 w-full text-left"
                items={[
                  { label: "Paid today", value: "$32.02" },
                  { label: "Plan", value: "4 × $32.02" },
                  { label: "Order", value: "#4821" },
                ]}
              />
            </Sheet.Body>
            <Sheet.Footer>
              <Button variant="outline" size="lg">
                View receipt
              </Button>
              <Button variant="lime" size="lg" onClick={() => setSheet(null)}>
                Done
              </Button>
            </Sheet.Footer>
          </>
        ) : active?.key === "receive" ? (
          <Sheet.Body className="flex flex-col items-center gap-4 pt-1">
            <div className="grid size-[176px] place-items-center rounded-[24px] bg-white p-4 text-[#13141f] ring-1 ring-ui-hairline-strong">
              <QrCode aria-label="QR code" size={144} strokeWidth={1.25} />
            </div>
            <p className="text-center text-[15px] text-ui-muted">Anyone can pay you with this code or link.</p>
            <div className="flex w-full gap-2">
              <Input hideLabel label="Your link" readOnly value="polaris.link/ana" wrapperClassName="flex-1" />
              <IconButton label="Copy link" icon={<Copy />} tone="lime" size="lg" onClick={() => toast({ title: "Link copied", tone: "success" })} />
            </div>
          </Sheet.Body>
        ) : active?.key === "plan" ? (
          <>
            <Sheet.Body className="flex flex-col gap-3">
              {payments.concat(payments).map((p, i) => (
                <TxRow
                  key={`${p.id}-${i}`}
                  variant="card"
                  leading={<Avatar name={p.customer} size="md" />}
                  title={`Instalment ${(i % 4) + 1} of 4`}
                  subtitle={p.date}
                  amount={-(p.amount / 4)}
                  static
                />
              ))}
            </Sheet.Body>
            <Sheet.Footer>
              <Button variant="dark" size="lg">
                Pay early
              </Button>
              <Button variant="lime" size="lg">
                Pay now
              </Button>
            </Sheet.Footer>
          </>
        ) : active?.key === "send" ? (
          <>
            <Sheet.Body className="flex flex-col gap-4">
              <Input label="To" placeholder="Name, email or phone" icon={<Search />} />
              {people.map((p) => (
                <TxRow key={p.name} leading={<Avatar name={p.name} tone={p.tone} />} title={p.name} subtitle="Sent by link" onClick={() => setSheet(null)} />
              ))}
            </Sheet.Body>
            <Sheet.Footer>
              <Button variant="lime" size="xl">
                Continue
              </Button>
            </Sheet.Footer>
          </>
        ) : null}
      </BottomSheet>

      <PaymentDrawer payment={drawer ? payments[0]! : null} onClose={() => setDrawer(false)} />
      <NewLinkDialog open={dialog} onOpenChange={setDialog} />
      <Dialog open={confirm} onOpenChange={setConfirm} size="sm" title="Revoke this key?" description="Apps using it stop working at once.">
        <Dialog.Footer className="border-t-0 pt-2">
          <Button variant="ghost" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
          <Button
            variant="dark"
            className="bg-ui-down text-white"
            onClick={() => {
              setConfirm(false);
              toast({ title: "Key revoked", tone: "error" });
            }}
          >
            Revoke
          </Button>
        </Dialog.Footer>
      </Dialog>
    </Section>
  );
}

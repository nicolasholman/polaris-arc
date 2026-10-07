# @polaris/ui

The Polaris component library, shared by the consumer app (`apps/app`) and the
merchant dashboard (`apps/business`). It reproduces the references in
[`docs/design/refs-v2`](../../docs/design/refs-v2) component by component (refs
A to D for the app, ref E, `ref-e-lumatrade.png`, for the merchant web app);
the contract is [`docs/design/system.md`](../../docs/design/system.md).

Open **`/gallery`** in either app to see every component in every variant,
set out beside the reference it comes from. Captures live in
[`docs/design/gallery`](../../docs/design/gallery).

## Setup in a Next.js app

```jsonc
// package.json
"dependencies": { "@polaris/ui": "workspace:*" }
```

```ts
// next.config.ts
transpilePackages: ["@polaris/ui", "@polaris/brand"],
```

```css
/* the global stylesheet */
@import "tailwindcss";
@import "@polaris/ui/styles.css";
```

`styles.css` registers the components with Tailwind (`@source "./src"`), loads
Satoshi, and defines every token. Everything is namespaced (`--ui-*` variables,
`ui-*` utilities, `font-satoshi`), so it sits beside an app's own tokens
without changing an existing screen, and nothing styles bare elements. Give a
screen root `className="ui-root"` (Satoshi, the theme's ground and text).

## Themes

| Theme | Where | How |
|---|---|---|
| Dark | the default: the consumer app and every analytics panel (refs A, B, D) | `:root` or `data-theme="dark"` |
| Light | ref C's light screens, light previews and the gallery toggle | `data-theme="light"` |
| Ref E | the merchant web app (`apps/business`: landing, sign-in, dashboard): a dark panel on a lime canvas | `data-theme="ref-e"` on `<html>` |

Scopes nest: `<ThemeScope theme="light">` for a light preview, `<Card theme="dark">`
for a dark panel inside it. Sheets, drawers, dialogs and select menus are
portalled but take the theme of whatever opened them.

Tokens (`bg-ui-*`, `text-ui-*`, `border-ui-*`): `canvas`, `surface-1..3`,
`hairline`, `hairline-strong`, `text`, `muted`, `dim`, `ink` / `on-ink` (the dark
button), `track`, `up`, `down`, `warn`, `info`, `purple-text`, `focus`,
`scrim`, `glass`; brand `lime`, `lime-bright`, `lime-logo`, `on-lime`,
`purple`, `purple-deep`, `purple-chart-from/to`, `crimson-from/to`; pastels
`blue`, `yellow`, `lilac`, `salmon`, `cyan`, `mint`, `teal`, `pink`, `sage`,
`sky`, `honey`, `mint-soft`. The light theme prints gains in purple-deep and
losses in red, as ref C does (and for AA contrast on white).

Ref E adds its sampled colours as constants (so its components render in any
theme): `frame` (the #E9FF9B canvas), `lime-button` (#B0C956), `lime-text`,
`lime-active`, `lime-chip`, `lime-chip-strong`, `axis`, `square`, `swap`, the
pills `pill-lime`, `pill-purple`, `pill-teal`, `pill-amber`, `pill-red`,
`pill-neutral` (each with `-text`), the chart's `chart-top` to `chart-bottom`,
and `shadow-ui-frame`. The `ref-e` theme itself sets the #121418 panel,
#1D2129 cards and inputs, #37393D hairlines, white text, #8E9199 muted labels (AA on every surface),
lime deltas, and recolours candles (lime up, orange down) and bars (olive,
lime selected). Radii `rounded-ui-frame` 32 (the panel), `rounded-ui-swap` 30
(the stacked cards), `rounded-ui-panel` 26 (outlined cards).

Radii: `rounded-ui-card` 28, `rounded-ui-tile` 20, `rounded-ui-row` 18,
`rounded-ui-key` 22, `rounded-ui-sheet` 32, `rounded-ui-field` 16. Shadows:
`shadow-ui-pop`, `shadow-ui-nav`, `shadow-ui-card`. Figures: `ui-figure`
(tabular, lining).

Icons are lucide at **1.75** stroke. Every icon slot sizes and strokes the icon
you pass (`icon={<Bell />}`); wrap an app in `<IconProvider>` for the same
default everywhere.

## Components

Every component takes `className` (merged with tailwind-merge, so yours
wins) and forwards refs where it renders one element.

### Primitives

| Component | Usage |
|---|---|
| `Button` | `<Button variant="lime" size="xl" block>Send</Button>` · variants `lime`, `lime-bright`, `white`, `dark`, `purple`, `violet`, `outline`, `ghost`; sizes `sm`–`xl`; `shape="rounded"` (ref B); `icon`, `iconRight`, `loading`, `asChild` |
| `IconButton` | `<IconButton label="Notifications" icon={<Bell />} tone="surface" dot />` · tones `surface`, `ink`, `outline`, `white`, `lime`, `purple`, `glass`, `ghost`, `black`; `shape="square"` |
| `Pill` | `<Pill tone="black" chevron onClick={open}>Main account</Pill>` · tones `ink`, `black`, `surface`, `white`, `glass`, `outline`, `lime` |
| `Chip` | `<Chip selected={tf === "5h"} onClick={…}>5h</Chip>` · `variant="plain" \| "outline" \| "solid" \| "pill"` (ref E's option chip: selected is the lime button's fill with a check; hovering an unselected one only brightens its hairline), `count` |
| `DeltaBadge` | `<DeltaBadge value={3.25} />` · `variant="chip"` with `amount` on colour, `soft`, `note="From last week"`, `tone="current"` (white on ref A's purple) |
| `Badge` | `<Badge tone="up" dot>Paid</Badge>` · `neutral`, `lime`, `purple`, `up`, `down`, `warn`, `info`, `ink` |
| `Avatar` | `<Avatar name="Ana Ruiz" size="lg" badge={<FlagBadge code="MX" />} />` · photo, initials on a pastel, or a brand circle (`color`, `icon`) |
| `AvatarStack` | `<AvatarStack people={customers} max={4} />` |
| `FlagBadge` | `<FlagBadge code="US" />` · US, EU, GB, IN, NG, MX, BR, CA |
| `Card` | `<Card theme="dark" variant="canvas" padding="lg">…</Card>` · `surface`, `raised`, `canvas`, `outline`; `radius="card" \| "tile" \| "row"` |
| `Tile` | `<Tile variant="raised">…</Tile>` |
| `ThemeScope` | `<ThemeScope theme="light" root>…</ThemeScope>` |
| `SectionHeader` | `<SectionHeader title="Recent sales" actionLabel="See all" href="/payments" />` · `size="lg"`, `subtitle`, `action` |
| `SegmentedControl` | `<SegmentedControl aria-label="Pay" options={[{ value: "now", label: "Pay now" }, { value: "four", label: "Pay in 4" }]} />` · `shape="pill"`, `size`, `block`, `variant="icon"` (square icon-only segments on a dark glass track, each `label` read out: ref B's line / candles toggle) |
| `RangeTabs` | `<RangeTabs value={range} onValueChange={setRange} onCalendar={pick} />` · `tone="onColor" \| "surface"` |
| `Tabs`, `TabList`, `Tab`, `TabPanel` | `<Tabs defaultValue="all" variant="pill"><TabList aria-label="Payments"><Tab value="all" count={24}>All</Tab></TabList><TabPanel value="all">…</TabPanel></Tabs>` · `text` (ref A), `pill`, `segmented` |
| `Money` | `<Money value={25841.11} />` · the dim dollar: `dim="both" \| "symbol" \| "cents" \| "none"`, `signed`, `compact`, `spaced` (ref D), `animate` |
| `Input`, `Textarea` | `<Input label="Business name" icon={<Store />} hint="…" error="…" />` · `variant="filled" \| "outline"`, `trailing` |
| `Select` | `<Select aria-label="Refresh" variant="outline" options={[…]} />` · `outline` (ref D), `white` (ref C), `chip` (in the candle panel), `filled` (forms); keyboard, type-ahead, flips above |
| `Toggle` | `<Toggle label="Automatic payouts" description="Every day at 17:00" />` |
| `Skeleton`, `SkeletonText` | `<Skeleton shape="card" height={200} />` |
| `EmptyState` | `<EmptyState icon={<Link2 />} title="No links yet" description="…" action={<Button>New link</Button>} />` |
| `IconDisc` | `<IconDisc icon={<ScanFace />} />` · the round icon well that leads a confirm, status or empty state; `size="sm" \| "md" \| "lg"` (48, 56, 64) |
| `Toaster`, `toast` | mount `<Toaster />` once; `toast({ title: "Link copied", tone: "success" })` |
| `Table`, `CellStack` | `<Table caption="Payments" columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={open} />` · `variant="lined" \| "rows"`, sorting, loading, `empty`, `hideBelow` (`sm` to `xl`) · `variant="plain"` is ref E's (see `DataTable`) |
| `Keypad`, `applyKey` | `<Keypad onKey={(k) => setAmount((a) => applyKey(a, k))} captureKeyboard />` |
| `AmountDisplay` | `<AmountDisplay value={amount} hint="Available $1,284.50" invalid={over} />` · shrinks as it grows, shakes when `invalid`, optional `caret` |
| `Logo`, `LogoMark` | `<Logo height={30} />` (the team's wordmark) · `<LogoMark size={28} />` (the star) |
| `SuccessCheck` | `<SuccessCheck label="Paid" />` · a disc that springs in, a ring that pulses once, a check that draws itself; `tone="lime" \| "up" \| "purple"`, `size` |
| `PageDots` | `<PageDots count={3} index={page} onSelect={setPage} />` · ref B's onboarding dots: the current page a white bar |
| `ScanFrame` | `<ScanFrame><video className="absolute inset-0 size-full object-cover" />…</ScanFrame>` · the 4:3 camera well with lime corner marks for a QR scanner |
| `Notice` | `<Notice tone="warn" title="Showing data from 2 minutes ago" action={<Button size="sm">Retry</Button>}>The last refresh failed.</Notice>` · `info`, `warn`, `down`, `lime`, `neutral`; why a control is disabled, a stale refresh, sample data |
| `ErrorState` | `<ErrorState title="We couldn't load your payments" description={message} onRetry={reload} />` · announced (`role="alert"`) |
| `Ticks` | `<Ticks done={2} total={4} />` · instalment ticks, `late` in amber, `size="sm"` for rows |
| `CopyButton` | `<CopyButton value={address} label="payout address" />` · a fixed-size IconButton (or `variant="button"`) with a check and a toast |
| `Menu` | `<Menu label="Account" trigger={<Avatar … />}><Menu.Header>…</Menu.Header><Menu.Item icon={<LogOut />} tone="danger" onSelect={signOut}>Sign out</Menu.Item></Menu>` · arrow keys, Home/End, Escape and Tab close, focus returns |
| `TxLink`, `shortHash` | `<TxLink hash={run.txHash} href={run.explorerUrl} />` · the shortened hash in figures with an arrow, opening the explorer in a new tab (`kind` names it: transaction, report, contract); unlinked text when `href` is null (a local chain); `children` replaces the hash ("View report") |
| `ProvenanceBadge` | `<ProvenanceBadge label="Verified by Chainlink CRE" meta="Oct 2" href={reportUrl} />` · a lime-tinted pill with a shield: who attested a figure, when, and "View report" (`linkLabel`) to the proof; only for facts a third party wrote on chain · `tone="neutral"` (a plain pill with a flask) for a report no one vouches for, such as a simulated or local CRE run ("Chainlink CRE (simulated)", "CRE workflow, local run") · `hash` shows the proof's transaction, unlinked, where there is no explorer · `size="sm"` |
| `Meter` | `<Meter value={12 / 60} label="Time since the last check" valueText="12 min of 60" tone="lime" />` · a thin gauge of an allowance used (`role="meter"`); tones `lime`, `amber`, `red`, `neutral` |

### Composites

| Component | Usage |
|---|---|
| `BalanceCard` | `<BalanceCard account="Main account" balance={1284.5} delta={2.1} quickActions={[…]} actions={[…]} more={{ label: "More" }} />` (ref A) |
| `ActionRow` | `<ActionRow actions={[{ label: "Add", icon: <Plus /> }]} more={{ label: "More" }} />` |
| `GradientCard` | `<GradientCard tone="crimson" label="Your credit line" value={<Money value={500} dim="cents" />} meta={<DeltaBadge variant="chip" … />} />` · `purple` + `layout="side"` (ref A), `purple-chart` (ref B) |
| `QuickTransfer` | `<QuickTransfer people={contacts} onAdd={newLink} onSelect={sendTo} />` |
| `TxRow` | `<TxRow leading={<Avatar … />} title="Oat & Ember" subtitle="9:10 AM" amount={-59} subAmount="Pay in 4 · $14.75" />` · `variant="card"` (ref D) |
| `AssetRow` | `<AssetRow leading={…} title="Kiko Ramen" subtitle="Oct 14 · 2 of 4" spark={[…]} value="$9.40" meta="+2.24%" />` · `variant="sunken"`, `sparkFill`, or `progress={{ done: 1, total: 4, current: 1 }}` for instalment ticks in the sparkline's place |
| `FeaturedTile` | `<FeaturedTile leading={…} title="Oat & Ember" value="$90.00" meta="Next Oct 12" progress={{ done: 2, total: 4 }} tint="#c2410c" />` |
| `MiniCardCarousel` | `<MiniCardCarousel aria-label="Pay from" cards={accounts} value={id} onValueChange={setId} />` |
| `StatTile` | `<StatTile value="+$850" label="Saved" tone="up" />` |
| `KeyValueGrid` | `<KeyValueGrid items={[{ label: "Amount", value: "$120.00" }]} />` · `variant="sunken"` for ref C on white |
| `DetailsList` | `<DetailsList items={[{ label: "Merchant", value: "Oat & Ember" }]} />` |
| `TileButton` | `<TileButton tone="purple" icon={<ArrowDownLeft />} label="Receive" />` · `ink`, `purple`, `lime`, `surface` |
| `BottomNav` | `<BottomNav floating items={tabs} value="home" linkAs={Link} />` · `variant="labelled"` (ref C), `activeTone="white"` (ref B), `size="sm"` (six 48px items on a phone) |
| `AppHeader` | `<AppHeader name="Ana Ruiz" unread onBell={open} />` · `mark` (the star before the wordmark, ref A), `logoHref` + `linkAs`, `variant="greeting"` (ref C) |
| `ScreenHeader` | `<ScreenHeader title="Send" onBack={back} action={…} />` · `variant="plain" \| "square" \| "arrow"` |
| `CardStack` | `<CardStack name="Oat & Ember" last4="2431" balance={62745} delta={11.05} actions={[…]} />` (ref D) · an action can be `disabled` with a `title` saying why · `decimals={2}` (with `spaced` off) to match figures written $1,284.50 |
| `ListRow`, `ListGroup` | `<ListGroup label="Account"><ListRow icon={<Bell />} title="Notifications" description="Payments due" href="/notifications" linkAs={Link} /></ListGroup>` · settings, menus and feeds: an icon well (`tone` `surface`, `lime`, `purple`, `down`, or ref E's pill tints `tint-lime`, `tint-purple`, `tint-teal`), a value, toggle or chevron; `variant="card"` (ref D) |
| `SideNav` | `<SideNav items={nav} value="payments" linkAs={Link} brand={<Logo height={30} />} brandCompact={<LogoMark size={30} />} />` · the web sidebar: hidden below 768px, an icon rail with tooltips to 1279px, full from 1280px; the lime active pill slides |
| `PageHeader` | `<PageHeader eyebrow="Good morning, Oat & Ember" title="Overview" actions={…} trailing={<Menu … />} />` |
| `CodeBlock` | `<CodeBlock samples={[{ key: "node", label: "Node", filename: "route.ts", code }]} copyable />` · tabs, line numbers, brand-accent syntax colour; the right edge fades while a line runs past it; the note hides in a narrow panel so Copy stays on the tab row; leave `copyable` off for code that doesn't run yet |
| `PhoneFrame` | `<PhoneFrame width={300}>…live components…</PhoneFrame>` · an iPhone around real components, for marketing pages |
| `StatCard` | `<StatCard tone="sage" icon={<Percent />} label="Sales" delta={23} value={<Money … />} spark={sales} />` · `sage`, `pink`, `honey`, `sky`, `lilac`, `lime`, `surface` |
| `CheckList` | `<CheckList items={[{ key: "price", label: "AUSD/USD", value: "$0.9998", limit: "at least $0.995", ok: true }]} />` · pass/fail checks with the figure observed over the rule it is held to: a lime check or an amber warning |

### Ref E: the merchant web app (`src/trade`)

The reference's own components, sized as it is at 1440 wide. The gallery opens
with them composed into the reference itself.

| Component | Usage |
|---|---|
| `AppFrame` | `<AppFrame><TopNav … /><main>…</main></AppFrame>` · a dark panel (a big soft shadow) floating on the lime canvas: from 1024px in 16px of lime with 24px corners, from 1280px in 32px with 32px corners; full bleed below. `floatFrom="xl"` to float only from 1280px, `"always"` for a preview |
| `TopNav`, `NavLink`, `NavDropdown` | `<TopNav brand={<Logo />} items={nav} more={{ label: "More", items: [developers, settings] }} value="overview" linkAs={Link} actions={…} compactActions={…} sheetFooter={…} />` · the text links with the reference's "Market ⌄" dropdown; below 1024px a compact bar whose menu is a `BottomSheet` that opens tall enough for every link and the footer; `contained` holds the bar to a 1280px content column |
| `WalletPill` | `<WalletPill address={wallet} label="payout wallet address" />` · the dark pill with an icon and the truncated 0x address; pressing it copies · `text` shows something else while `address` is what it copies (the customer web: "Dollar account ···· 4821", copying the receive link) · `displayAddress` is what the toast, tooltip and name show when the copied value isn't fit to show (a link with an account in it) · `onPendingClick` and `pendingLabel` make the pill act before there is anything to copy ("Sample account ···· 2451" starts an account) |
| `PrimaryButton`, `SecondaryButton` | `<PrimaryButton size="lg" block icon={<ArrowUpFromLine />}>Withdraw $1,250.00</PrimaryButton>` · #B0C956 with a near-black label; the dark #1D2129 one with its icon after; `sm` is the nav's pill, `lg` the widget's 50px buttons |
| `IconSquareButton` | `<IconSquareButton label="Refresh" icon={<RefreshCw />} />` · the 40px outline squares (refresh, QR, settings); `tone="solid" active` for the chart toggle's raised lime one |
| `DeltaChip` | `<DeltaChip value={3.27} suffix="today" />` · lime on the dark lime chip, coral when negative, grey at 0.00%, `variant="strong"` in the balance card, `label` for "New" · `goodWhen="down"` for money going out (spending): a rise turns amber, a fall lime |
| `StatusPill` | `<StatusPill tone="purple">Pay in 4</StatusPill>` · `lime`, `purple`, `teal` (the reference's), `amber` (retrying, at risk), `red`, `neutral`; `icon`, `size="sm"` |
| `TimeframeChips` | `<TimeframeChips options={["1h", "24h", "1w", "1m"]} value={tf} onValueChange={setTf} />` · a radio group; the active chip on #1D2129; options can carry labels (`All 638`) |
| `ChartTypeToggle` | `<ChartTypeToggle value={type} onValueChange={setType} />` · line and candles |
| `TextTabs` | `<TextTabs aria-label="Move money" options={[{ value: "withdraw", label: "Withdraw" }, …]} value={tab} onValueChange={setTab} />` · BUY / SELL: uppercase, the active one lime; a real tablist; `size="auto"` fits phones |
| `PairHeader`, `Coin`, `CoinPair`, `PolarisCoin`, `DollarCoin` | `<PairHeader coins={[<PolarisCoin key="p" />, <DollarCoin key="d" />]} title="Sales / USD" options={metrics} value={metric} onValueChange={setMetric} trailing={<ChartTypeToggle … />} />` · overlapping round coins, the first in front; the title opens a menu when it has options; `as="h1"` for a page head; `titleClassName` (e.g. `max-sm:text-[20px]`) |
| `GradientLineChart` | `<GradientLineChart label="Sales, last 24 hours" data={points} height={380} formatValue={usd} formatBubbleNote={null} lastLabel="Now" />` · the line runs lime yellow to orange with a warm fill; a white bubble, a glowing dot and a dashed crosshair on hover, drag and arrow keys; four round y labels from under the lowest point to over the highest (`spanTicks`); x labels on round times (`tickZone` local or UTC) as many as fit; below `compactBelow` (480px) a 48px axis with short labels (`compactNumber`: "2.5k"); all zero: a dashed baseline and `empty` (which can hold buttons); a line that never moves is drawn in the top colour, not one mid-plot orange |
| `DataTable`, `TableName` | `<DataTable caption="Recent payments" columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={open} />` · borderless on the panel, muted headers, 54px rows; `TableName` is the small round icon and the name |
| `SwapCard`, `SwapToggle`, `SwapStack` | `<SwapStack top={<SwapCard coin={<PolarisCoin size={42} />} symbol="AUSD" caption="You send" value={amount} onValueChange={setAmount} metaLabel="Balance" meta="3,196.97" />} bottom={…} toggle={<SwapToggle label="Switch" onClick={swap} />} />` · the stacked #1D2129 cards with the round button over the seam; the figure can be an input |
| `BalanceSummaryCard` | `<BalanceSummaryCard label="Available balance" value="$3,196.97" delta={7.45} stats={[{ label: "Network fee", value: "$0.00" }, …]} />` · the outlined card with its chip and the stats row |
| `PanelCard` | `<PanelCard title="Customers this week" action={<SeeAll />}>…</PanelCard>` · ref E's card for what the reference doesn't show: `variant="outline"` (the summary card's border) or `filled` (#1D2129) |
| `FigureRow` | `<FigureRow value={<Money value={1284.5} />} delta={4.5} deltaSuffix="this week" right={<TimeframeChips … />} />` · the big figure under the pair header with its delta chip (`deltaLabel` for a figure in dollars, `badge` for another chip, `deltaGoodWhen` for spending), the chips on the right; a skeleton while `value` is undefined |
| `RunList` | `<RunList items={[{ id, tag: "Collected", tone: "lime", title: "2 instalments collected", detail, meta: "12 s ago", trailing: <TxLink … /> }]} />` · a log of automated runs or events in the table's language: status pill, what happened with a muted line, a link on the right; the pill moves before the title below 640px; `empty` in place of no items |

### One route, two layouts (`src/trade/Adaptive.tsx`, `src/overlays/AdaptiveSheet.tsx`)

The customer app (apps/app) is a phone app below 1024px and ref E's framed desktop from 1024px.

| Component | Usage |
|---|---|
| `Adaptive`, `useAdaptive`, `useIsDesktop`, `DESKTOP_QUERY` | `<Adaptive phone={<>{children}<TabBar /></>} desktop={<DesktopShell>{children}</DesktopShell>} />` · the server renders both layouts and CSS shows the one that fits (no flash, no hydration mismatch); after hydration only the matching one stays mounted, without remounting it. `useAdaptive()` gives `{ mode, settled }`: `settled` is false while both are in the page, so something that must exist once (a route sheet) waits for it |
| `AdaptiveSheet` | `<AdaptiveSheet open={open} onOpenChange={setOpen} snapPoints={["fit"]} maxWidth={440} aria-label="Confirm" desktop="dialog">…</AdaptiveSheet>` · exactly the given BottomSheet below 1024px, a `Dialog` (or `desktop="drawer"`) from 1024px, with the same `Sheet.Body` and `Sheet.Footer` |
| `data-theme-lg="ref-e"` | `<html data-theme="dark" data-theme-lg="ref-e">` · a scope that is dark below 1024px and ref E from 1024px (styles.css); overlays opened from it follow |

### Charts (hand-built SVG)

| Component | Usage |
|---|---|
| `Sparkline` | `<Sparkline data={series} color="var(--ui-up)" height={32} />` · `fill`, `baseline="avg"`, `curve="linear"` |
| `LineArea` | `<LineArea label="Credit score" data={weeks} height={200} glow reference="avg" interactive />` |
| `CandlestickChart` | `<CandlestickChart label="Daily volume" data={ohlc} timeframes={["1D", "1W", "1M"]} reference={{ value: 97.45 }} />` · lime up, purple-deep down, dashed last-price line with a lime tag, crosshair on hover, drag and arrow keys, draw-in · `formatAxis` and `axisWidth` for the price axis ("1,300.00" beside a "$1,284.50" tag), `timeAxis` (with `lastLabel`) for the line chart's round times along the bottom |
| `DonutChart` | `<DonutChart label="Sales by mode" data={[{ label: "Pay now", value: 56685, color: "var(--ui-teal)" }, …]} />` · round ends overlapping like ref D (`gap` opens them), `startAngle`, glass value tags, hover or focus a segment to read it |
| `BarChart` | `<BarChart label="Customers this week" data={week} formatValue={(v) => `$ ${v}`} />` |
| `HBarList` | `<HBarList label="Spending by category" data={[{ label: "Food", value: 35 }, …]} />` |
| `ProgressLegend` | `<ProgressLegend items={[{ label: "Pay now", value: 60, color: "var(--ui-teal)" }]} />` · `direction="column"` |

All charts draw in once on mount (a later re-measure does not replay it) and
stay still under reduced motion.

### Presentation

| Component | Usage |
|---|---|
| `BottomSheet` | `<BottomSheet open={open} onOpenChange={setOpen} snapPoints={["half", "full"]} title="Plan"><Sheet.Body>…</Sheet.Body><Sheet.Footer>…</Sheet.Footer></BottomSheet>` · snaps `compact`, `half`, `full`, `fit` (hugs its content, up to full) or px; velocity-based swipe to dismiss; content scrolls without fighting the drag; a sheet opened over another stacks above it with its own backdrop; `onClosed` fires once the exit animation has finished (route sheets navigate then) |
| `SheetStage` | `<SheetStage className="min-h-dvh"><App /></SheetStage>` · scales the page behind an open sheet to 0.96 with rounded corners and makes it inert; stacked sheets keep it back until the last one closes |
| `Sheet.Header`, `Sheet.Body`, `Sheet.Footer` | the parts every overlay shares (also `Drawer.*`, `Dialog.*`) |
| `Drawer` | `<Drawer open={!!p} onOpenChange={…} title="Payment" description={p.id}><Drawer.Body>…</Drawer.Body></Drawer>` · right side on desktop, a half/full sheet below 768px |
| `Dialog` | `<Dialog open={open} onOpenChange={setOpen} title="New payment link"><Dialog.Body>…</Dialog.Body><Dialog.Footer>…</Dialog.Footer></Dialog>` · centred on desktop, a sheet below 768px |
| `useOverlay` | inside any of them: `const { close, kind } = useOverlay()` |

All three are `aria-modal` with a focus trap, Escape to close (the topmost
layer only), a body scroll lock, safe-area padding, and a fade instead of
travel under reduced motion. Focus goes to the first control on open (on
touch screens, to the panel itself, so no keyboard pops up) and returns to
the opener on close.

### Helpers

`cn`, `formatMoney`, `formatPercent`, `formatCompact`, `moneyParts`,
`useMediaQuery`, `useControllable`, `useScrollLock`, `useFocusTrap`,
`useReducedMotionSafe` (reduced motion that reads `false` until hydrated, so
server and client markup match; the charts use it for their draw-ins),
`IconSlot`, `IconProvider`.

## Gallery

`@polaris/ui/gallery` exports `<Gallery app="business" | "app" />`. Each app
mounts it at `/gallery` (`apps/*/src/app/gallery/page.tsx`); the dashboard's
route skips Privy, so it renders without a session.

## Font licence

`fonts/Satoshi-Variable.woff2` is **Satoshi Variable** by Indian Type Foundry,
downloaded from Fontshare (<https://www.fontshare.com/fonts/satoshi>). Fontshare
fonts are free for personal and commercial use under the ITF Free Font
License (<https://www.fontshare.com/licenses/itf-ffl>); the font files may be
embedded in apps and websites but not sold or redistributed on their own. The
file is the variable font (weight axis 300 to 900) and includes `tnum`, so
figures are tabular without a fallback face.

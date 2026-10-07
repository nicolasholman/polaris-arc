# Polaris design system v2

**This supersedes `mobile.md` for both apps.** The team chose four new
references, and the product is rebuilt on a shared component library,
`packages/ui`, that reproduces their components exactly:

| Ref | File | What we take from it |
|---|---|---|
| **A · Aheadly** | [`refs-v2/ref-a-aheadly.webp`](refs-v2/ref-a-aheadly.webp) | The mobile app's core: dark base, lime balance card, round action buttons, quick-transfer avatars, transaction rows, the floating pill nav with a lime active circle, the transfer screen (card carousel, big amount, lime Send, keypad with a purple backspace), the purple spending card and pastel category bars |
| **B · Findex** | [`refs-v2/ref-b-findex.webp`](refs-v2/ref-b-findex.webp) | Onboarding (3D glass coins, "Invest smarter." headline, white Get Started), the gradient portfolio card, featured tiles, watchlist rows with sparklines, the purple chart card with range tabs, stat tiles, the Market/Limit segmented control, Sell/Buy buttons |
| **C · Trading** | [`refs-v2/ref-c-trading.webp`](refs-v2/ref-c-trading.webp) | Candlesticks on a dark panel (lime up, purple down, price tags, timeframe chips), the key-value stat grid, the details list, the Send/Receive/Top Up tile buttons, the pill nav with a lime "Home" tab, purple Sell / lime Buy. Its layout and density shape the web dashboard, which is dark (see "Web dashboard") |
| **D · Sales** | [`refs-v2/ref-d-sales.webp`](refs-v2/ref-d-sales.webp) | Analytics: the sales card with a sparkline and a delta chip, the weekly bar chart with a tooltip, the donut with floating value tags, the legend with thin progress bars, recent-sales rows, the balance card with side action squares |
| **E · LumaTrade** | [`refs-v2/ref-e-lumatrade.png`](refs-v2/ref-e-lumatrade.png) | **The merchant web app** (landing, sign-in, dashboard): a dark rounded panel floating on a lime canvas, a top nav with a wallet pill and a lime button, the pair header with overlapping coins, the big figure with a delta chip, timeframe chips, the lime-to-orange gradient line with a white bubble, the borderless table with status pills, and the trade widget (BUY / SELL, stacked cards with a swap button, full-width buttons, the outlined balance card). See "Web dashboard" |

Match them **exactly**: proportions, radii, spacing, weights, colours, icon
style, and the density of each component. The content is ours, mapped below.

## Type

- **Satoshi** (Fontshare, free for commercial use) for everything. Self-host
  the variable woff2 in `packages/ui/fonts`. Big numbers use weight 500–700
  with −0.03em tracking; labels 400–500.
- Figures are tabular (`font-variant-numeric: tabular-nums`). If Satoshi lacks
  `tnum`, use Inter Tight for numbers only.
- **The "dim dollar" pattern:** in `$25,841.11` the `$` and the cents render at
  about 40–55% opacity (refs A, B). It's a component (`<Money>`), not ad-hoc
  markup.

## Tokens

**Dark theme** (the mobile app; the merchant web uses ref E's theme, see
"Web dashboard"):

| Token | Value |
|---|---|
| bg | `#0F1011` |
| surface-1 | `#1A1B1D` |
| surface-2 | `#232426` |
| surface-3 | `#2C2D30` |
| hairline | `rgba(255,255,255,.06)` |
| text | `#F5F5F5` |
| text-muted | `#8A8D93` |
| text-dim | `#55585E` |

**Light theme** (ref C's light screens; kept in `packages/ui` for light
previews and the gallery, but no product screen uses it as its shell):

| Token | Value |
|---|---|
| bg | `#EEEDF2` |
| surface | `#FFFFFF` |
| surface-2 | `#F6F5F9` |
| ink | `#13141F` |
| muted | `#6E7080` |

**Brand and accents:**

| Token | Value |
|---|---|
| lime | `#9CEF5E` (ref A; the balance card and primary CTA) |
| lime-bright | `#D2EC34` (ref C; up candles, Buy, Top Up) |
| lime-logo | `#BFFA62` |
| purple | `#8E5CF0` (ref A spending card, keypad backspace) |
| purple-deep | `#6A17EE` (ref C Receive, Sell, down candles) |
| purple-chart | `#923ECA` → `#B45AF2` (ref B chart card gradient) |
| crimson | `#DE2F53` → `#F0506B` (ref B portfolio card gradient) |
| up | `#3DDC84` |
| down | `#FF5A6E` |

**Chart pastels** (refs A, D): blue `#8FB2FF`, yellow `#FFE98C`,
lilac `#D8A8FF`, salmon `#FF8C85`, cyan `#7EF2F4`, mint `#92F2B2`,
teal `#63B59C`, pink `#F8D2D1`, sage `#B0CCC0`, sky `#C5DBF2`.

**Shape and motion:**

| Token | Value |
|---|---|
| Radius | cards 28px, tiles 20px, rows 18px, buttons and pills fully round, keypad keys 22px |
| Elevation | none on dark (surfaces separate by tone); the nav pill has a soft shadow |
| Motion | spring presses (scale .96); numbers tween; charts draw in; everything respects reduced motion |

## packages/ui: real, reusable components

**Primitives:**
- `Button` (lime, white, dark, purple, outline, ghost; sizes; icon slot)
- `IconButton` (round, the bell and back buttons)
- `Pill`, `Chip`, `DeltaBadge` (up and down)
- `Avatar`, `AvatarStack`, `FlagBadge`
- `Card`, `Tile`, `SectionHeader` (title + "See all")
- `SegmentedControl` (Market/Limit, Expenses/Savings)
- `RangeTabs` (1D 1W 3M 6M All + calendar)
- `Money` (the dim-dollar formatter)
- `Keypad`, `AmountDisplay`
- `Toggle`, `Input`, `Sheet`, `Toast`, `Skeleton`, `EmptyState`

**Composites:**
- `BalanceCard` (ref A lime)
- `GradientCard` (ref B crimson and purple)
- `ActionRow` (round white action buttons)
- `QuickTransfer` (plus circle + avatars)
- `TxRow` (brand circle, title, time, amount, sub-amount)
- `AssetRow` (logo, name, sparkline, value, delta)
- `FeaturedTile`
- `MiniCardCarousel` (ref A transfer cards)
- `StatTile`, `KeyValueGrid`, `DetailsList` (ref C)
- `TileButton` (ref C Send/Receive/Top Up)
- `BottomNav` in two variants: icon pill with a lime active circle (ref A), and labelled "Home" pill (ref C)
- `AppHeader` (logo + bell + avatar)
- `ScreenHeader` (back, title, action)
- `CardStack` (ref D balance card with side squares)

**Charts (hand-built SVG, no chart library):**
- `Sparkline`
- `LineArea` (ref A spending and ref B price chart, with a gradient fill and
  a glow line)
- `CandlestickChart`
  - lime up and purple-deep down, wicks, a dashed last-price line with a lime
    tag and a purple reference tag
  - a right-hand price axis and timeframe chips
  - a crosshair on hover or drag, animated draw-in
- `DonutChart`: rounded segment ends, gaps, floating value tags, and a centre
  label
- `BarChart`: rounded bars with a selected bar and a tooltip bubble, ref D
- `HBarList`: ref A category bars, the width proportional to the share, a
  pastel fill and the percentage at the end
- `ProgressLegend`: ref D's Giveaway/Affiliate/Offline row

**Also required:**
- A **component gallery** route in each app (`/gallery`) renders every
  component in every variant. It is how reviewers compare against the
  references.
- **Icons:** `lucide-react` at 1.75 stroke, matching the references' outline
  icons.

## Mobile app screens (dark), reference → Polaris

1. **Onboarding (3 pages, ref B screen 1).**
   - Full-bleed Lottie art: glass coins in lime, purple and crimson, floating
     and turning.
   - A big two-line headline, one line of sub, page dots, and a white
     **Get Started**.
   - The pages:
     1. "Get paid in dollars. Instantly." (coins drift in)
     2. "Split it in four. Pay as you go." (a lime card splits into four
        segments)
     3. "Send money anywhere. By link." (a coin flies along an arc between
        two pins)
   - Then Face ID account creation (Mera).
2. **Home (ref A screen 1).**
   - `AppHeader` with the Polaris wordmark (it carries its own star, so no
     separate `LogoMark`), the bell and the avatar.
   - A lime `BalanceCard`:
     - a "Main account ▾" dark pill, and bolt and pencil round buttons
     - "USD · AUSD" labels, then `$1,284.50` with a +2.1% delta
     - `ActionRow` (Add, Receive, Send, More)
   - `QuickTransfer` (send by link to contacts).
   - "Recent activity" as `TxRow`s: merchant logo circle, time, amount, and
     the Pay in 4 instalment as the sub-amount.
   - `BottomNav` variant A: Insights · Cards · **Home** · Links · Profile.
3. **Send (ref A screen 2):**
   - the recipient row with a swap icon
   - `MiniCardCarousel`: Dollar account, Pay later line, Boost
   - `AmountDisplay` with the dim `$`
   - a lime **Send**, then the `Keypad` with a purple backspace
4. **Insights (ref A screen 3):** a purple "My spending" `GradientCard` with a
   `LineArea` and delta; `SegmentedControl` Expenses | Plans + a calendar
   `IconButton`; an `HBarList` of spending by category (Food, Shopping,
   Travel, Bills, Subscriptions, Other).
5. **Credit (ref B screen 2):**
   - a crimson `GradientCard`, "Your credit line" `$500.00`, with a delta chip
   - "Active plans" `FeaturedTile`s: merchant logo, remaining, next payment,
     4-tick progress
   - "Upcoming" `AssetRow`s with sparklines of the instalment schedule
6. **Credit score (ref B screen 3 + ref C screen 2):**
   - a purple chart card, "648 (+12, +1.9%)", with `RangeTabs`, toggling
     between `LineArea` and `CandlestickChart` (the score, week by week)
   - `StatTile`s (8 on time · $500 line · next tier $1,000)
   - a `KeyValueGrid`
   - a dark **Pay early** and a white **Raise limit**
7. **Checkout /pay/[id] (ref C screen 3 + ref B):**
   - `ScreenHeader` with the merchant name and a share button
   - a `KeyValueGrid` (Pay in 4, Interest, First payment, Due today) and a
     `DetailsList` (Merchant, Order, the four due dates). Pay in 4 charges
     nothing at checkout: payment 1 falls one interval after the plan opens,
     as `PolarisLoanEngine.installmentDueAt(i) = startedAt + (i+1) × interval`
   - `SegmentedControl` Pay now | Pay in 4
   - a purple **Pay in 4** and a lime **Pay now**
8. **Activity (ref D screen 3):** `TxRow`s grouped by day, with filter chips.
9. **Cards / Profile (ref D screen 3 top):** `CardStack` with side action
   squares, account details, and sign out.
10. **Claim and Plans:** the same parts.

## Presentation: most screens slide up as bottom sheets

The team asked for most screens to pop up from the bottom. Only the five
tabs are full screens; everything you *do* slides up over them.

- **Tabs (full screens, BottomNav):** Home · Insights · Cards · Activity ·
  Profile.
- **Sheets:**

  | Sheet | Size |
  |---|---|
  | Send | full |
  | Receive (QR + request link) | half |
  | Add money | half |
  | Checkout `/pay/[id]` | full |
  | Claim | full |
  | Select account (the card carousel) | half |
  | Transaction detail | half |
  | Plan detail | half, drag up to full |
  | Credit line | full |
  | Credit score (candles) | full |
  | Notifications | half |
  | Settings and account actions | half |
  | Filters | half |
  | Confirm with Face ID | compact |
  | Success receipt, with a check-mark animation | half |

- **`BottomSheet` in packages/ui:**
  - Motion drag with snap points (compact, half, full) and a velocity-based
    swipe to dismiss.
  - A spring in and out; the backdrop dims to about 60% and blurs by 8px; the
    screen behind scales to 0.96 with rounded corners, like iOS.
  - The sheet has 32px top corners, a grab handle and an optional
    `Sheet.Header` (title + close).
  - The inner content scrolls without fighting the drag.
  - `aria-modal`, a focus trap, Escape to close, body scroll lock, safe-area
    padding. Reduced motion means a fade, no travel.
- **Routing:** Next.js App Router parallel routes (`@sheet`) with intercepting
  routes (`(.)send`, `(.)pay/[id]` and so on). Opening one from inside the app
  presents it as a sheet over the current tab, and its URL still deep-links. A
  cold link (a checkout link from a merchant) opens the sheet over a blurred
  Home.
- **Web dashboard:**
  - Detail views (payment, plan, payout) open in a right-hand `Drawer`, and
    create/edit flows (new link, new key, webhook) in a `Dialog`.
  - Below 768px both become `BottomSheet`s.

## Accounts

- **Consumer app:** Face ID through Mera is the primary sign-up, as the Agora
  bounty requires.
  - Privy (email or Google, with an embedded wallet) is offered beneath it as
    "Continue with email", using the same Privy app as the dashboard.
  - The account layer is one interface with three implementations: mera,
    privy and dev.
  - The Android build's Privy app client id is read from
    `NEXT_PUBLIC_PRIVY_ANDROID_CLIENT_ID`.
- **Web dashboard:** Privy, live. It reads the app id and secret from
  `apps/business/.env.local` (git-ignored), with real sign-in, embedded
  merchant wallets and server-side token verification.
  - The sign-in page's one **Continue** button opens Privy's own modal, which
    lists exactly the methods turned on in the Privy dashboard (today email
    and external wallets; Google appears by itself once it is enabled there).
    We never draw a button for a method that is off.
  - Every merchant gets an embedded payout wallet at sign-in (the client
    config requests it for all users).

## Web dashboard (apps/business)

**The web is ref E.** `<html data-theme="ref-e">`: the tokens sampled from the
reference, Satoshi, and the `src/trade` components of `packages/ui`. It is the
same product as the app (lime on near-black, Satoshi, the Polaris coin), in
ref E's layout and components.

- **Frame:** from 1024px the whole page is a dark panel (#121418, a big soft
  shadow) floating on the #E9FF9B canvas (`AppFrame`): 16px of lime and 24px
  corners to 1279px, 32px of lime and 32px corners from 1280px; below 1024px
  the panel is full bleed. The landing, /login and the 404 hold their top nav
  to the sections' 1280px column (`TopNav contained`), so the wordmark lines
  up with the content.
- **Tokens:** panel #121418; raised cards and inputs #1D2129; hairlines
  #37393D; the primary button #B0C956 with a near-black label; lime text and
  gains #AABC6D on a #20231E / #2B2F24 chip; white text; muted labels #8E9199
  (lifted from the reference's #7E8189 so every label passes AA: 5.1:1 on
  #1D2129, 4.6:1 on #252A33); axis labels #7C7F87; status pills lime #2B2E26
  / #DEEABA, purple #291F32 / #B77FD2 (5.2:1), teal #1B2D30 / #71C8C2, and
  amber (retrying, at risk) and red in the same style. On a #1D2129 surface
  (a drawer, a dialog, a sheet) tiles and dark buttons step up to #252A33,
  never the surface's own colour.
- **Lime, decided:** buttons and fills keep ref E's olive #B0C956; accent
  *text* (the hero's second line, the landing's figures, the active nav link
  and tab, the 404) takes ref E's brighter #C9D77E (`--ui-lime-active`),
  which sits closer to the wordmark's light end. Money figures use the dim
  dollar (`Money`: "$" and cents at 45%) everywhere, as in the mobile app:
  page figures, balance cards and drawers. The chart line runs lime yellow at the top to orange lower
  down over a warm dark fill; the tooltip is a white bubble over a glowing dot
  and a dashed line. Radii: panel 32, stacked cards 30, outlined cards 26,
  pills round.
- **Top nav, not a sidebar** (`TopNav`): the Polaris mark and wordmark, then
  Overview, Payments, Links, Pay in 4 and Payouts, a **More** dropdown
  (Developers, Settings) like the reference's "Market ⌄", the payout wallet
  pill (click to copy), the lime **New link** pill and the avatar menu (test
  mode, sample data, settings, sign out). Below 1024px a compact bar whose
  menu is a `BottomSheet`.
- **Every page opens like the reference's chart:** overlapping coins and the
  page's name (`PairHeader`), then the big figure with its `DeltaChip` and the
  page's chips (`TimeframeChips`: timeframes or filters), then a borderless
  `DataTable` with `StatusPill`s. A right-hand column holds the page's widget
  or summary (`BalanceSummaryCard`, `PanelCard`). On phones the page's main
  action or summary comes first (the WITHDRAW widget on Payouts, REQUEST on
  Links, the summary on Payments and Pay in 4) and a column a phone hides is
  folded into the first cell's sub line ("Pay in 4 · Website audit"). From
  1280px the right column stays in view beside long tables.
- **Overview** is the reference's main screen: Sales / USD (a dropdown for Pay
  in 4 and Subscriptions), the period's gross with its change, line or
  candles, 1h 24h 1w 1m, the `GradientLineChart`, and recent payments; on the
  right the money widget (**WITHDRAW** / **REQUEST**: the AUSD "You send"
  card over the USD "Arrives" card with the swap button, Withdraw, Change
  payout address and the available balance card; REQUEST makes a payment
  link that buyers can pay now, in 4 or monthly). Below it, outlined cards:
  customers this week, sales by mode, credit exposure with the Nansen
  reasons, Chainlink CRE collections and the Envio feed; the cards in a row
  end together (the charts fill them). The line is one smooth curve, like
  ref E: the running total since the chart's left edge (Gaussian-smoothed,
  never dipping), so it starts at 0.00 and ends at "Now" on the headline
  figure; the candles show the trailing-window total instead. The chart's y
  axis is four round labels spanning the line (steps of 1, 1.5, 2, 2.5, 3, 4,
  5, 6, 7.5 or 8 per power of ten, so the peak sits near the top), its x
  labels fall on round times and the last reads "Now". A merchant with no sales yet sees a dashed baseline with New
  payment link and Preview inside the chart, and a three-step Getting
  started checklist instead of the cards.
- **Payments, Links** (with the REQUEST widget), **Pay in 4** (the ledger,
  instalment ticks in lime), **Payouts** (the WITHDRAW widget large,
  automatic payouts, history), **Developers** (keys, webhooks, the SDK
  snippet) and **Settings**, all from the same components. Detail views open
  in a `Drawer` (raised tiles, and ref E's full-width lime and dark buttons at
  the bottom) and create and edit flows in a `Dialog`; both become
  `BottomSheet`s below 768px.
- **Landing (`/`) and sign-in (`/login`)** sit in the same frame under the
  same top nav. The landing's hero visual is the product itself, built from
  the components (the chart panel beside the stacked-card widget), never a
  screenshot; its sections keep their copy. `/login` has one **Continue**
  (Privy's modal) beside the chart panel.
- **Honest data:** anything not yet backed by a live service (the indexer,
  the CRE workflow, Nansen, the relayer) shows an empty or "not connected"
  state. When sample data is on, every card that shows it carries a
  `Sample` pill (amber), and so does every row from a server's sample book
  where it sits beside the merchant's own. A control that can't work yet is
  disabled with the reason beside it; it is never left to fail (Withdraw on a
  $0.00 balance, links before the checkout origin is set, the demo shop
  before it is deployed).
- **Pay in 4 copy** follows the contracts: 10% APR pro-rated over the four
  weekly payments, so $200 is 4 × $50.38 ($1.53 interest, $201.53 in total).
  Never "interest-free".

## Customer web (apps/app from 1024px)

**The customer app is two layouts on one set of routes.** Below 1024px it
is the phone app (refs A to D, the sections above), unchanged. From 1024px
it is ref E, built from the same `src/trade` components as the merchant web,
so the reference, the merchant web and the customer web read as one system.

- **How:** `<html data-theme="dark" data-theme-lg="ref-e">` switches the
  tokens at 1024px. The tabs layout renders `<Adaptive phone={…} desktop={…}>`
  (both on the server, CSS shows one, only the matching one stays mounted
  after hydration), and each screen renders its desktop layout in the desktop
  branch (`apps/app/src/desktop`). Route sheets present the desktop way:
  a right `Drawer` for details (Payment details, a plan, Notifications), a
  centred `Dialog` for short flows (Send, Receive, Add money, Pay or claim,
  Claim, Select account), or a page in the frame (Credit line, Credit score,
  Settings, a checkout). The URLs and deep links are the phone's. Sheets
  inside flows (Face ID confirm, the receipt, filters) are `AdaptiveSheet`s:
  the same BottomSheet on a phone, a Dialog on a desktop.
- **Frame and nav:** `AppFrame` and `TopNav` like the merchant: the Polaris
  wordmark; Home, Activity, Cards, Pay in 4, Insights and **More** (Credit,
  Settings); the dollar account's pill ("Dollar account ···· 4821": four
  digits worked out from the account, like a card's, never its hex tail; it
  copies your receive link, and the toast names the link by site and name,
  never the address; signed out it is the sample's "Sample account ···· 2451"
  and starts an account); the lime **Send** pill; the avatar menu (Profile,
  Notifications, Settings, Log out).
- **Home** is the reference's main screen mapped to a buyer: **Balance / USD**
  (a dropdown for the Pay later line and Boost), the balance with its change
  over the timeframe (a percentage; dollars when the frame starts near zero;
  a grey "No change" when nothing moved), line or candles, 1h 24h 1w 1m, the
  balance as **one smooth continuous curve** (each payment eases in over
  about the average gap between moves, so every payment is its own wiggle
  and there are no long plateaus, and the line ends exactly on today's
  figure; a line that never moved is drawn in the top colour), the bubble
  resting on the latest payment inside 15-85% of the plot like the
  reference's "550.24", and recent activity in the borderless table with
  status pills (Paid, Pay in 4 · 2 of 4, Received, Subscription, Sent by
  link). The candles carry a dollars-and-cents price tag and round times
  along the bottom. On the right the widget: **SEND** (the "USD ·
  You send" card over the "Link · They get" card, the swap button changes who
  gets it, Send, Pay a Polaris link, and the credit card: Available to spend,
  what paying back freed this week, next payment, active plans, score) and
  **RECEIVE** (your code, your link with Copy and Share, shown as
  "polarispay.app/send · Lena", never the account's address, Add money,
  money in this week).
- **Pages** open like the merchant's: coins and the page's name, the big
  figure with its chip and chips on the right, the table, the right column.
  Activity (filters, search, Drawer), Cards (the accounts table beside ref
  D's card stack), Pay in 4 (/plans: every plan with lime instalment ticks, a
  plan's Drawer with Pay early, subscriptions), Insights (spending as the
  line, by category, by kind), Credit line, Credit score (Line and Candles),
  Profile and Settings. Tables that need the width (Activity, Pay in 4) put
  the right column under them until 1280px, as two columns that each stack
  on their own (the summary and its buttons, the panel and the note).
  Insights' chip reads spending the right way round (more is amber, less is
  lime) and its side card shows the month so far, never the page's figure
  again. Payment details is the merchant drawer's shape (the status pill by
  the name, raised tiles with the plan's ticks); a link still waiting has no
  receipt yet.
- **Checkout** (/pay/[id]) stands alone under the wordmark and a Secure
  checkout pill: one centred card of one height in every mode (switching
  never jumps it), the order on the left (what the merchant gets today, one
  Face ID, under a second), Pay now (selected first, as on the phone: your
  balance before and after), Pay in 4 (4 × $50.38, the four dates, nothing
  today) or Subscribe (the next four charges) on the right, each offering
  the other, then Face ID. A shop's popup window is narrow, so it keeps the
  phone checkout.
- **Dialogs** use ref E's pieces, not the phone's palette: Add money is
  three rows in the pill tints, Share buttons are the lime button, the claim
  hero is the olive with the coin inside it, and a claimed link's receipt
  takes the claim's place in its one Dialog. Pay or claim opens on the paste
  field (a computer with a camera gets "Scan with this computer's camera").
  The 404 sits in the frame under the wordmark with a lime 404, like the
  merchant's.
- **Sample data** is marked, as on the merchant web: while balances, plans
  and activity come from the sample book (a month of an ordinary life, kept
  in the tab's sessionStorage so a reload keeps what you just did), every
  page figure and summary card carries the amber Sample pill.
- **Onboarding** is the framed canvas like /login: Face ID first with
  Continue with email beneath it on the left, the animated art on the right.
- **Buyer copy** is the phone's: no wallet, gas or blockchain words; Pay in 4
  is 10% a year, $200 is 4 × $50.38.

Captures: `docs/design/customer-web/` (1440×900 and 1024×768, the overlays,
and `home-vs-ref-e.png`, the reference beside the 1440 Home).

## Rules

- **Nothing one-off.** A screen is composed from `packages/ui`; if a screen
  needs something new, it becomes a component first.
- **Copy rules from `mobile.md` still apply to the buyer path:** no wallet, gas
  or blockchain words.
- **Accessibility:** contrast AA, focus rings, labelled icon buttons,
  reduced motion.

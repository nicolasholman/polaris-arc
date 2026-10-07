> **Superseded by [`system.md`](system.md)** (design system v2, four new references). This file records the first reference and the v1 screens built from it.

# The Polaris app: visual design

**This supersedes the old Polaris brand for the consumer app (`apps/app`).**
The reference is [`mobile-reference.webp`](mobile-reference.webp): three
screens (home, select card, send money). Match it **exactly**: layout,
proportions, colours, radii, type weight and spacing. Where the reference has a
screen, copy it. Where it doesn't (checkout, claim, plans, activity,
onboarding), build the new screen from the same components so it looks like it
came from the same file.

## Tokens (sampled from the reference)

| Token | Value | Where |
|---|---|---|
| `--bg` | `#EFF1F3` (top) → `#E8EAEC` (bottom), a very soft vertical gradient | Screen background |
| `--surface` | `#F9F9F9` | Cards, Send/Receive buttons, panels, list groups |
| `--key` | `#EFF1F3` | Keypad keys (on a `--surface` panel) |
| `--ink` | `#111111` | Promo card, primary buttons, floating nav, pills like "Main card" |
| `--ink-card` | `#181818` | The black card |
| `--lime` | `#B3DE00` | Accent: the lime card, active key, the chip on the balance label, the amount cursor |
| `--lime-deep` | `#8BA907` | Embossed shading on the lime card |
| `--text` | `#0B0B0B` | Headings, amounts |
| `--text-muted` | `#6B7078` | Labels ("Linda's card balance"), dates |
| `--pill` | `#E4E6E8` | Grey pills ("Money hold $2,500", "Change") |
| `--negative` | `#D83B3B` | Money out, e.g. "- $573" |
| `--positive` | `#7EA40E` | Money in, e.g. "+ $1000" |
| Radius | cards 24px, list group 20px, buttons 28px (pill-like), keys 16px, avatars full | |
| Shadow | none on cards; the reference is flat. The floating nav and bottom CTA have a soft `0 10px 30px rgba(0,0,0,.18)` | |

**Type:** Inter Tight for display (the balance, amounts, wordmark) and Inter
for text.

- **Balance:** 46–48px, weight 700, letter-spacing −0.045em.
- **Amounts on cards:** 26px, weight 500, tight.
- **Labels:** 15px, weight 400, `--text-muted`.
- **Row titles:** 16px, weight 500. **Row meta:** 13px, muted.
- **Wordmark:** 30px, weight 800, −0.05em.

## Layout (390px wide)

- **Gutters and gaps:** 16px side gutter; 12px gap between stacked cards.
- **Header row:** wordmark left; right side has a 40px circular help button
  (white, 1px `#D9DBDE` ring, "?" icon) and a black pill button (height 40,
  icon + label, white text) with a small lime sparkle dot at its top-right.
- **Floating bottom nav:** a black pill, about 230×56, centred, 16px above the
  bottom safe area, sitting over the content. It holds five 22px outline icons
  in white; the active one is full white, the rest 70%.
- **The subtle grid:** the home balance area has a faint square grid (1px lines
  at about 4% black, 24px cells) that fades out radially around the balance.

### Measured at 402px (what the app implements)

The numbers above were a first read. Measured from the cropped screens
(`reference-home.png`, `reference-cards.png`, `reference-send.png`, 2× of a
402px-wide phone), the reference is smaller and tighter, and these win:

- **Ground:** `#EFF1F3`, flat for the top third, then falling to `#CFD1D5` at
  the bottom edge of the screen (fixed to the viewport, not the page).
- **Gutter 15px** (so full-width cards are 372px); **13px** between stacked
  surfaces on Home and Send, **12px** between the Select card cards.
- **Radius:** surfaces and cards 18px (the reference uses smoothed corners of
  about 16–17px); buttons, pills and keypad keys are full capsules.
- **Surfaces:** `#F9F9F9` with a white hairline and the faintest lift, never a
  visible border.
- **Type:** Inter Tight throughout, tracked in: body −0.015em, titles −0.04em.
  Wordmark 30px/500; section titles ("Send again") 18px/500; labels 16px/400;
  row titles 16px/500; row meta 14px in `#45484C` (darker than labels);
  "see more" and pills 14px; the balance 46px/700 at −0.065em.
- **Header:** a 41px row whose top is 44px down: the wordmark, a 41px
  near-white help disc, 9px, and the 40px ink pill with a yellow two-star
  sparkle on its corner.
- **Floating nav:** 226×52, 21px above the bottom, five 21px outline icons on
  40px targets (home with a smile, a pulse in a circle, a banded card, a
  dollar in a circle, a person in a circle); inactive at 55% white.

## Screen map: reference → Polaris

### 1. Home (reference screen 1)

| Reference | Polaris |
|---|---|
| "Pesse" wordmark | "Polaris" |
| "Rewards" black pill | **"Pay later"** pill (opens the credit line), same sparkle dot |
| "Linda's card balance" + lime card chip + chevron | "Your dollar balance" + lime chip + chevron (opens *Select card*) |
| "$521,098.31" | The balance |
| "Money hold $2,500" grey pill | **"Credit available $500"** |
| Send / Receive | Send (↗) and Receive (↙, shows a QR code and a request link) |
| Dark promo card with a silver coin | **"Send dollars abroad, fee free"** / "Pay anyone in 150+ countries with a link. It lands in under a second." + the generated silver coin (`public/assets/coin.png`) |
| "Send again" avatars with bank badges | "Send again" avatars (generated portraits) with **country-flag badges**, + Add |
| "History transaction" / see more | "History" / see more: merchant payments (−, red), money received (+, green), instalments collected (−) |
| Floating nav | Home · Activity · Cards · Pay · Profile |

### 2. Select card (reference screen 2)

- **Title and header button:** "Select card", with a "+ New card" pill
  relabelled **"+ Add money"**.
- **Three stacked cards** (about 372×218, radius 24), each with a giant
  embossed "Polaris" watermark bleeding off the bottom: the same colour as the
  card, with a light top-left inner highlight and a darker bottom-right shade.
  - **Lime:** "Dollar account", balance, "•••• 2451", and a **"Main card"**
    black pill with a check.
  - **Black:** "Pay later", "$500 available", "•••• 0095".
  - **White:** "Boost", "$300 locked", "•••• 1122" (collateral that raises the
    limit).
- **Card label:** top-right, where the reference shows "VISA", put a heavy
  italic **"POLARIS"** wordmark. Never use the Visa mark.
- **"Close":** a black pill at the bottom.

### 3. Send money (reference screen 3)

- **Header:** a back circle, "Send money" and a help circle.
- **"Send to" card:** the avatar with its flag badge, name, phone number or
  handle, and a "Change" pill.
- **Amount:** "$19" at about 64px bold, with a 3px lime text cursor that
  blinks.
- **"From" card:** a lime card thumbnail, "Dollar account", "Balance $…" and
  "Change".
- **Keypad panel:** 1–9, 000, 0, backspace. Keys are 16px-radius `--key`
  tiles; the pressed key flashes lime.
- **Primary button:** a full-width black "Send money" button, 56px high.

### Screens with no reference (same components)

- **Checkout (`/pay/[id]`):**
  - The merchant as the "Send to" card, the amount, then three choices as
    selectable surface cards: Pay now, Pay in 4 (**4 × $50.38**, interest
    shown) and Subscribe.
  - The limit with its reasons as muted rows.
  - A black "Confirm with Face ID" button.
- **Claim (`/claim`):** the promo-card style dark hero, "$50 from Studio Sol",
  the coin asset, then "Claim with Face ID".
- **Plans:** surface cards with four instalment ticks, lime for paid and grey
  for due.
- **Activity:** the History list, full screen.
- **Onboarding:** the lime card hero with the embossed wordmark, "Create your
  account with Face ID", and a black button.

## Motion

- **Pressing:** buttons scale to 0.97 on press.
- **Keypad:** a lime flash of 180ms on the pressed key.
- **Balance:** counts up on first paint (600ms, ease-out).
- **Cards:** the Select card stack slides up with a 60ms stagger. The selected
  card lifts 4px and gets its "Main card" pill.
- **Reduced motion:** respect `prefers-reduced-motion`.

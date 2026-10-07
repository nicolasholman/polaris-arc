# @polaris/landing

The Polaris marketing site: **Stripe for every app on Arc.** One link to get
paid now, later or every month, in USDC. Buyers pay with a passkey (Face ID)
from any chain through Circle's CCTP, payments are final on Arc in under a
second, and gas, paid in USDC, is covered by Polaris. Polaris runs on Arc
testnet today.

The page is static: it reads no chain data and holds no keys. Layout, type,
colour and every animation follow
[`docs/design/landing.md`](../../docs/design/landing.md).

Next.js 16 (App Router, TypeScript strict), Tailwind CSS 4, Motion
(`motion/react`), Lenis for smooth scrolling and Inter Tight through
`next/font` (downloaded from Google Fonts at build time).

## Run it

From the repository root:

```bash
pnpm install
pnpm --filter @polaris/landing dev        # http://localhost:3200
pnpm --filter @polaris/landing build      # static production build
pnpm --filter @polaris/landing start      # serve the build on :3200
pnpm --filter @polaris/landing typecheck  # next typegen && tsc --noEmit
```

## Environment

All optional and public; see [`.env.example`](.env.example).

| Variable | Used for | Unset |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | "Get the app" (apps/app) | in-page anchor |
| `NEXT_PUBLIC_BUSINESS_URL` | "Log in", "Start accepting", "Create a link" (apps/business) | in-page anchors |
| `NEXT_PUBLIC_REPO_URL` | Footer GitHub link and blog cards | `https://github.com/nickthelegend/polaris-arc` |

## Editing copy

Every word is in [`src/content.ts`](src/content.ts): headings as arrays of
lines (one per line on desktop), paragraphs as plain strings, two-tone
paragraphs as `lead` + `rest`. The testimonials speak for the demo itself
(the Halcyon demo shop, a buyer, the merchant dashboard), not for customers.

## Images

Drop photos into `public/assets/` under these names (any size):
`hero.jpg`, `streaks.jpg` (plus optional `streaks.mp4`), `phone.jpg`,
`testimonial.jpg`, `article-1.jpg` to `article-3.jpg`, `avatar-1.jpg` to
`avatar-3.jpg`. A missing file shows a gradient in its section's palette and
is never requested (`src/lib/assets.ts`). The static build needs a rebuild
when a file is added or removed.

## Sections

One component per section in `src/components/sections/`, in page order:
`HeroNav` + `Hero` (+ `HeroCard`), `LogoStrip`, `StripeSection`,
`CreditSection`, `Pricing`, `Faq`, `Testimonial`, `Blog`, `Talk`, `Footer`.
Shared motion primitives and their timings live in `src/components/motion/`
(see its README). With `prefers-reduced-motion`, or without JavaScript, every
reveal renders in its final state.

# @polaris/landing

The Polaris marketing site: **Stripe for every app on Monad.** It rebuilds
the 25-second reference recording described in
[`docs/design/landing.md`](../../docs/design/landing.md) (layout, type,
colour and every animation) with Polaris content.

Next.js 16 (App Router, TypeScript strict), Tailwind CSS 4, Motion
(`motion/react`) for all animation, Lenis for smooth scrolling and Inter Tight
through `next/font`.

## Run it

From the repository root (Node 22, pnpm 10):

```bash
pnpm install
pnpm --filter @polaris/landing dev        # http://localhost:3200
pnpm --filter @polaris/landing build      # static production build
pnpm --filter @polaris/landing start      # serve the build on :3200
pnpm --filter @polaris/landing typecheck  # next typegen && tsc --noEmit
```

`next/font` downloads Inter Tight from Google Fonts at build time.

## Images

Photos are dropped in by hand. Put them in `public/assets/`, at any size,
under exactly these names:

| File | Where it shows |
|---|---|
| `hero.jpg` | Hero background (subject right of centre, dark on the left) |
| `streaks.jpg` | Green motion-blur background of the "Pay any way you like" card |
| `streaks.mp4` | Optional: plays muted, looped and inline over `streaks.jpg` (its poster) |
| `phone.jpg` | "Face ID, not seed phrases" card: a person smiling at their phone |
| `testimonial.jpg` | Full-bleed testimonial background |
| `article-1.jpg` … `article-3.jpg` | The three blog cards |
| `avatar-1.jpg` … `avatar-3.jpg` | "Talk to the team" avatars and the "Send money" panel |

Until a file exists, its slot shows a gradient in its section's palette, and
the streaks card draws drifting CSS streaks, so nothing ever shows a broken
image. The page checks which files exist on the server (`src/lib/assets.ts`)
and never requests a missing one. `next dev` picks up a new file on reload;
the static build needs a rebuild both when a file is added and when one is
removed (a file deleted after the build is still requested; its slot falls
back to the gradient, but the request fails).

## Editing copy

All the words are in [`src/content.ts`](src/content.ts): headings as arrays of
lines (one per line on desktop), paragraphs as plain strings (they reveal
line by line wherever they wrap), and two-tone paragraphs as `lead` + `rest`.
**The testimonials are placeholders** to replace with real quotes before
launch.

## Sections

One component per section in `src/components/sections/`, in page order:

1. `Hero.tsx` (+ `HeroCard.tsx`): photo with 0.85x parallax, the headline
   (its word reveal is CSS, so it plays before hydration), and the Payments
   card whose bars grow on a staggered spring. `HeroNav.tsx`, the nav and its
   load sequence, is the page's banner: it renders outside `<main>` and sits
   over the hero, as the footer sits outside `<main>` too.
2. `LogoStrip.tsx`: the pill and the endless wordmark marquee (40px/s).
3. `StripeSection.tsx`: "Stripe for every app on Monad", the mint card and
   the dark card with its frosted panels.
4. `CreditSection.tsx`: "Credit that feels like cash, fast": chip rows, the
   counting credit line, the photo card.
5. `Pricing.tsx`: "0.5% per payment" and the lime calculator with its slider.
6. `Faq.tsx`: the olive accordion; the first item opens on entry.
7. `Testimonial.tsx`: full-bleed quote with the 6s autoplay ring. Autoplay
   pauses on hover and focus and stops after one full cycle.
8. `Blog.tsx`: "From the blog" and the three article cards.
9. `Talk.tsx`: "Talk to the team" on the white-to-lime gradient.
10. `Footer.tsx`: the inset olive footer card.

## Motion

Shared primitives live in `src/components/motion/`, with the spec's timings in
`tokens.ts`:

- `BlurWords`: word-by-word blur reveal (opacity, `blur(12px)`, `0.25em`,
  700ms on `cubic-bezier(.2,.7,.2,1)`, 70ms apart), triggered at 20% visible.
- `BlurLines`: paragraphs line by line (80ms apart), keeping two-tone colours.
- `Rise`, `Grow` (a card growing up with its bottom edge fixed; wrap what
  belongs to its top, such as a photo or a title, in `GrowAnchor` and it
  rides up with the edge), `Pop`, `DrawLine`.
- `Marquee`: constant px/s, eases to a stop on hover.
- `CountUp` / `useCountUp`, `RollingNumber` (spring tween with per-digit blur),
  `ProgressRing`.
- `SmoothScroll`: Lenis plus Motion's config.

With `prefers-reduced-motion`, everything renders in its final state: Motion
skips every animation, Lenis is off, marquees and autoplay stop, and a CSS
fallback shows all reveals even before hydration. Reveals that animate a size
or a colour carry their final value in a custom property for it (`rv-h`,
`rv-w`, `rv-fill` in `globals.css`). The same rules, plus photos and the
counted credit amount, are repeated in a `<noscript>` style in `layout.tsx`,
so the page is complete without JavaScript.

Animated text is rendered once, so copying it and `textContent` read
normally; headings also carry their text as `aria-label`.

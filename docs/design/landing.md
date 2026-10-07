# The Polaris landing page: design and motion

The reference is the 25-second screen recording `reference.mp4` (kept outside
the repo at `D:\Project\polaris\reference.mp4`). Its frames are summarised
below. Rebuild its **layout, type, colour and every animation exactly**, with
Polaris content. The browser chrome and blurred green backdrop in the video
are only the presentation around the site; don't build them.

## Tokens (sampled from the video)

| Token | Value | Where |
|---|---|---|
| `--olive` | `#2D3A02` | Headings, primary buttons, the FAQ section, footer card, the dark "fuel" card, dark chart bars |
| `--lime` | `#E1FF67` | Hero CTA, calculator card, FAQ text, the bottom of the page gradient |
| `--lime-bar` | `#B7D83D` | Mid-tone chart bars and chips |
| `--mint` | `#D8ECE9` | "Control spend" card |
| `--lavender` | `#E0E5F8` | "Intuitive performance" card |
| `--paper` | `#FFFFFF` page, `#FDFFF2` → `#E1FF67` for the closing gradient | |
| `--muted` | `#8A8F7A` | Secondary copy (two-tone paragraphs: the lead-in in olive, the rest muted) |
| `--pill` | `#EEEEEA` | The "Join over 500…" pill |
| Radius | cards 22px, buttons fully rounded (height 36–44), the footer card 28px | |

**Type:** a tight grotesk (Inter Tight or Geist).

- **Headings:** weight 500, letter-spacing −0.04em. The hero is about 64px on
  desktop and the section headings about 44px.
- **Body:** 15–16px.

**Layout:** a 1200px content width with a generous 88px side gutter.

## Sections, in order (Polaris content in *italics*)

1. **Hero:** a full-bleed photo (`/assets/hero.jpg`), with the subject right
   of centre and dark on the left, under a dark gradient.
   - **Nav:** a translucent dark pill on the left (*Product · Business ·
     Developers*); the wordmark centred (*Polaris* with its mark); on the right
     a *Log in* pill and a white *Get the app* pill, plus a menu icon.
   - **Headline** at the bottom left, in white: *"Credit, built into the
     payment."*
   - **Sub:** *"Payment links, pay-in-4 credit and subscriptions for every app
     on Monad. Settled in dollars in under a second."*
   - **CTA:** a lime pill, *"Get started →"*.
   - **Card:** a white floating card at the bottom right, *"Payments"* with a
     *"+23%"* olive badge and *Weekly / Monthly / Yearly* tabs. It holds a
     stacked bar chart (four columns of olive, lime-bar and lime blocks), a
     thin vertical scroll indicator on its left, and *"It updates as each
     payment lands"*.
2. **Logo strip:** a grey pill, *"Built on Monad, with the best in crypto
   infra"*, above an infinite, left-scrolling marquee of wordmarks (*Monad,
   Privy, Chainlink, Agora AUSD, Envio, Nansen, Circle USDC, Zerion*, as text
   wordmarks with a simple glyph) and faded left and right edges.
3. **"Stripe for every app on Monad":**
   - **Left:** the heading; two buttons, *"Start accepting →"* (olive) and
     *"Read the docs"* (outline); two paragraphs with olive lead-ins:
     - ***Experience checkout without a wallet*** *— buyers pay with Face ID,
       merchants get dollars.*
     - ***The power of Stripe,*** *with credit built in. …*
   - **Mint card:** *"Get paid in 0.8s at any size"*, arrow bullets
     (*Payment links and QR codes, no code / Webhooks and a ten-line SDK*) and
     *"Create a link →"*.
   - **Dark olive card:** a faint outline flower doodle top-left and *"Pay in
     4, with credit built in"* in lime. Two frosted panels float in from the
     right: *"Send money"* (avatars + a plus) and *"Across borders"* (flags).
4. **"Credit that feels like cash, fast":** the heading with an outline
   *"Learn more →"* pill on the right, and three cards.
   - **(a)** A green motion-blur background (`/assets/streaks.jpg`, or the
     animated loop `/assets/streaks.mp4`) holding a white card, *"Pay any way
     you like"*. Inside it, two rows of chips scroll horizontally in opposite
     directions (*Pay in 4 · Subscriptions · Send by link · Payment links ·
     Payouts · Cross-border · QR*; alternating olive, lime and grey chips).
     Small print: *"We pay the merchant up front, so you can split it."*
   - **(b)** Lavender, *"Intuitive credit."*, holding a white card:
     *"Credit line"*, *"$153.23 available of $1,000"* counting up, a legend
     (*Paid 22% · Available 63% · Due 15%*) and a three-segment bar that fills.
   - **(c)** A photo card (`/assets/phone.jpg`: a person smiling at their
     phone) titled *"Face ID, not seed phrases"*, with body copy at the bottom
     in white.
5. **"0.5% per payment. No hidden fees.":**
   - **Left:** the heading, a paragraph and *"Start accepting →"*.
   - **Right:** a lime calculator card with a line-art leaf/arrow doodle top
     right:
     - *"Calculator"*, then *"Your monthly sales"* with an animated number
       and a draggable slider.
     - *"You keep"* *$X*; *"Cards would take"* *$Y* (at 2.9% + 30¢ for 100
       orders).
6. **FAQ:** a full-bleed olive section.
   - **Left:** a lime *"Frequently Asked Questions"* heading and a muted-lime
     sub.
   - **Right:** an accordion with hairline dividers and plus icons.
   - **Five questions:**
     - Do my customers need a crypto wallet?
     - How does pay-in-4 work?
     - When do I get paid?
     - What does it cost?
     - Is it live?
7. **Testimonial:** a full-bleed photo (`/assets/testimonial.jpg`). At the
   bottom left: the name and role in lime, then a large lime quote. At the
   bottom right: round prev/next buttons, with a progress ring animating on
   *next* (autoplay, 6s).
8. **"From the blog":** the heading with an underlined *"Show all"*, and three
   image cards (`/assets/article-1..3.jpg`) with white titles over a bottom
   gradient.
9. **"Talk to the team":** centred.
   - **Background:** a white → lime (`#FDFFF2` → `#E1FF67`) gradient that
     continues behind the footer.
   - **Content:** the heading, a paragraph, then *"Builders"*, an avatar
     stack (`/assets/avatar-1..3.jpg`), a *3+* bubble, a divider and *"Book a
     demo →"*.
10. **Footer:** an olive rounded card inset on the lime gradient.
    - **Content:** wordmark, blurb, *"More about us"*, nav links, *Contact
      us*, *Location*, round white social icons, copyright and language
      switcher (En Es Fr De Ru).

## Motion (this is what the video is about)

- **Word blur-in.** Every heading, the hero sub, paragraphs and card titles
  reveal word by word: `opacity 0→1`, `filter: blur(12px)→0` and
  `translateY(0.25em)→0`, 700ms on `cubic-bezier(.2,.7,.2,1)` with a 70ms
  stagger between words. Headings trigger when 20% visible. Paragraphs reveal
  line by line (80ms stagger); the two-tone paragraphs keep their colours.
- **Hero on load.**
  - The wordmark writes on letter by letter through a clip mask.
  - The *Get the app* pill slides out from behind *Log in*.
  - The headline blurs in, then the sub, then the CTA fades from olive to lime.
  - The Payments card rises 50px and fades in; its title blurs in; its bars
    grow from zero height with a staggered spring, then the badge pops.
- **Scroll.** Sections are normal flow, with no pinning. The hero photo has a
  slight parallax (moving at about 0.85× the scroll speed).
- **Card entrances.** Cards rise 40px and fade, staggered 120ms left to right.
  The mint card grows from a shorter height. The floating panels on the dark
  card slide in from beyond its right edge.
- **Marquees.** The logo strip scrolls at about 40px/s. The chip rows run in
  opposite directions at about 30px/s. Each pauses on hover.
- **Counters.** The credit number counts up (1.2s, ease-out) when visible, and
  the segmented bar fills in step. The calculator's number tweens when the
  slider moves; on first view the slider animates from 0 to about 25%.
- **FAQ.** The first item opens automatically when the section enters; items
  open and close with height and opacity transitions (350ms), and the plus
  rotates into a minus.
- **Testimonial.** The quote reveals line by line with the blur. The next
  button's ring draws over the autoplay interval.
- **Articles.** The three cards enter at different depths (the first higher)
  and settle into a row.
- **Implementation:** Motion (framer-motion) or GSAP ScrollTrigger. Respect
  `prefers-reduced-motion`: show the final state and don't animate.

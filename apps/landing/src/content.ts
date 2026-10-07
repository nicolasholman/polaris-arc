/**
 * Every word on the landing page lives here, so copy can be edited in one
 * place. Sections read from this file and never hard-code text.
 *
 * Headings are arrays of lines: on desktop each entry is one line, on phones
 * they flow. Paragraphs are plain strings; they reveal line by line wherever
 * they happen to wrap. In a two-tone paragraph `lead` is the olive lead-in and
 * `rest` is muted.
 *
 * Calls to action that lead to the other apps go through `linkTo`: an in-page
 * anchor until NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_BUSINESS_URL are set.
 */

import { APP_URL, BUSINESS_URL, linkTo } from "./lib/links";

export const site = {
  title: "Polaris: Stripe for every app on Monad",
  description:
    "Payment links, pay-in-4 credit and subscriptions for every app on Monad. Settled in dollars in under a second.",
  name: "Polaris",
};

export const nav = {
  links: [
    { label: "Product", href: "#product" },
    { label: "Business", href: "#pricing" },
    { label: "Developers", href: "#faq" },
  ],
  login: { label: "Log in", href: linkTo(BUSINESS_URL, "/login", "#") },
  cta: { label: "Get the app", href: linkTo(APP_URL, "/", "#talk") },
};

export const hero = {
  headline: ["Credit, built into", "the payment."],
  sub: "Payment links, pay-in-4 credit and subscriptions for every app on Monad. Settled in dollars in under a second.",
  cta: { label: "Get started", href: "#product" },
  card: {
    title: "Payments",
    badge: "+23%",
    tabs: ["Weekly", "Monthly", "Yearly"] as const,
    caption: "It updates as each payment lands",
    /**
     * The stacked chart, one data set per tab. Each column floats `top` px
     * below the chart's top edge and stacks three blocks downwards: `mid`
     * (olive-green), `olive` and `lime`, with `gap` px between them.
     */
    series: {
      Weekly: [
        { top: 45, h: [15, 31, 10], gap: 4 },
        { top: 29, h: [19, 38, 11], gap: 5 },
        { top: 16, h: [11, 23, 24], gap: 3 },
        { top: 0, h: [25, 54, 38], gap: 6 },
      ],
      Monthly: [
        { top: 30, h: [20, 42, 14], gap: 5 },
        { top: 46, h: [12, 30, 20], gap: 4 },
        { top: 8, h: [24, 48, 18], gap: 6 },
        { top: 18, h: [16, 40, 30], gap: 5 },
      ],
      Yearly: [
        { top: 60, h: [12, 24, 12], gap: 4 },
        { top: 40, h: [16, 34, 16], gap: 5 },
        { top: 20, h: [20, 44, 22], gap: 5 },
        { top: 0, h: [26, 58, 40], gap: 6 },
      ],
    },
  },
};

export const logos = {
  pill: "Built on Monad, with the best in crypto infra",
  items: [
    { name: "Monad", glyph: "monad" },
    { name: "Privy", glyph: "privy" },
    { name: "Chainlink", glyph: "chainlink" },
    { name: "Agora AUSD", glyph: "agora" },
    { name: "Envio", glyph: "envio" },
    { name: "Nansen", glyph: "nansen" },
    { name: "Circle USDC", glyph: "circle" },
    { name: "Zerion", glyph: "zerion" },
  ] as const,
};

export const stripe = {
  heading: ["Stripe for every", "app on Monad"],
  primary: { label: "Start accepting", href: linkTo(BUSINESS_URL, "/login", "#pricing") },
  secondary: { label: "Read the docs", href: "#faq" },
  paragraphs: [
    {
      lead: "Experience checkout without a wallet",
      rest: "— buyers pay with Face ID, merchants get dollars.",
    },
    {
      lead: "The power of Stripe,",
      rest: "with credit built in. Links, a checkout API, subscriptions and payouts, with pay-in-4 on every order and the merchant paid up front.",
    },
  ],
  mint: {
    title: ["Get paid in 0.8s", "at any size"],
    bullets: ["Payment links and QR codes, no code", "Webhooks and a ten-line SDK"],
    cta: { label: "Create a link", href: linkTo(BUSINESS_URL, "/login", "#pricing") },
  },
  dark: {
    title: ["Pay in 4, with", "credit built in"],
    send: "Send money",
    borders: "Across borders",
  },
};

export const credit = {
  heading: "Credit that feels like cash, fast",
  cta: { label: "Learn more", href: "#faq" },
  chips: {
    title: "Pay any way you like",
    rowA: ["Pay in 4", "Subscriptions", "Send by link", "Payment links"],
    rowB: ["Payouts", "Cross-border", "QR", "Pay in 4", "Subscriptions"],
    note: "We pay the merchant up front, so you can split it.",
  },
  line: {
    title: ["Intuitive", "credit."],
    label: "Credit line",
    amount: 630,
    of: "Available of $1,000",
    legend: [
      { label: "Paid", value: 22, tone: "olive" },
      { label: "Available", value: 63, tone: "sage" },
      { label: "Due", value: 15, tone: "stone" },
    ] as const,
  },
  photo: {
    title: "Face ID, not seed phrases",
    body: "Open a link, look at your phone, and you've paid. No wallet, no gas, no twelve words to lose.",
  },
};

export const pricing = {
  heading: ["0.5% per payment.", "No hidden fees."],
  body: "Pay 0.5% when a payment lands, against about 3% for cards. Instalments, collections and credit risk are ours, not yours.",
  cta: { label: "Start accepting", href: linkTo(BUSINESS_URL, "/login", "#talk") },
  calculator: {
    title: "Calculator",
    salesLabel: "Your monthly sales",
    max: 100_000,
    step: 100,
    /** Where the slider settles on first view, as a share of `max`. */
    intro: 0.25,
    keep: "You keep",
    cards: "Cards would take",
    feeRate: 0.005,
    cardRate: 0.029,
    cardFixed: 0.3,
    orders: 100,
    footnote: "Cards at 2.9% + 30¢, for 100 orders a month",
  },
};

export const faq = {
  heading: ["Frequently", "Asked Questions"],
  sub: "Straight answers about checkout, credit, payouts and what it costs.",
  items: [
    {
      q: "Do my customers need a crypto wallet?",
      a: "No. They open your link and create an account with Face ID in a few seconds. There's no wallet to install, no seed phrase and no gas to hold. Prices are in dollars, and they tap Confirm once.",
    },
    {
      q: "How does pay-in-4 work?",
      a: "At checkout the buyer can split an order into four payments against a credit line read from their payment history. You're paid 100% up front. They pay 10% APR, pro-rated, so a $200 order becomes 4 × $50.38, shown before they confirm.",
    },
    {
      q: "When do I get paid?",
      a: "The moment the payment lands. Monad finalises in under a second, so you see Paid before the page could reload, in dollars, and you can withdraw the same minute.",
    },
    {
      q: "What does it cost?",
      a: "0.5% per payment, with nothing monthly and nothing to set up. Pay-in-4 costs you the same: credit risk and collections are ours, not yours.",
    },
    {
      q: "Is it live?",
      a: "On Monad testnet today. Payment links, pay-in-4, subscriptions and send-by-link run end to end there. Credit stays on testnet while we're in beta; mainnet starts with Pay now and Send, capped.",
    },
  ],
};

/**
 * What the demo itself shows, in the voice of its two sides: the demo shop
 * (Halcyon), a buyer and the merchant dashboard. No invented customers.
 */
export const testimonials = {
  intervalMs: 6000,
  items: [
    {
      name: "Halcyon, the demo shop on Monad testnet",
      quote:
        "“One link, and the order was paid in dollars before the buyer closed the tab. Pay in 4 at checkout, with the credit risk never ours to carry.”",
    },
    {
      name: "The buyer, on their phone",
      quote:
        "“I looked at my phone and it was paid. No wallet to install, no gas to hold, no seed phrase to write down.”",
    },
    {
      name: "Polaris for Business, the merchant dashboard",
      quote:
        "“Ten lines of SDK and one webhook. Payouts land the same minute, and every payment, plan and collection is on the dashboard.”",
    },
  ],
};

export const blog = {
  heading: "From the blog",
  showAll: { label: "Show all", href: "https://github.com/nickthelegend/polaris-monad#readme" },
  articles: [
    { title: "Checkout on Monad, without a wallet", href: "https://github.com/nickthelegend/polaris-monad#mera-the-entire-account-layer" },
    { title: "Pay in 4, paid in full: credit at checkout", href: "https://github.com/nickthelegend/polaris-monad#pay-in-4-end-to-end" },
    { title: "Subscriptions that skip a month, not stack it", href: "https://github.com/nickthelegend/polaris-monad#monad-track-02-consumer-products-and-payments" },
  ],
};

export const talk = {
  heading: ["Talk to the team"],
  body: "Tell us what you sell and how you want to be paid. We'll help you ship a link, the checkout or the SDK, and answer anything about credit and payouts.",
  label: "Builders",
  more: "3+",
  cta: { label: "Book a demo", href: "mailto:hello@polarispay.app" },
};

export const footer = {
  blurb: "Stripe for every app on Monad: payment links, credit at checkout and subscriptions, settled in dollars in under a second.",
  more: { label: "More about us", href: "#product" },
  links: [
    { label: "Product", href: "#product" },
    { label: "Business", href: "#pricing" },
    { label: "Developers", href: "#faq" },
    { label: "Contact.", href: "#talk" },
  ],
  contact: {
    title: "Contact us",
    lines: ["hello@polarispay.app", "polarispay.app"],
  },
  location: {
    title: "Location",
    lines: ["Remote-first, on Monad.", "Built for Monad Metropolis 2026"],
  },
  socials: [
    { label: "GitHub", icon: "github", href: "https://github.com/nickthelegend/polaris-monad" },
  ] as const,
  copyright: ["© 2026 — Polaris", "All rights reserved"],
  languagesLabel: "Languages",
  languages: ["En", "Es", "Fr", "De", "Ru"],
};

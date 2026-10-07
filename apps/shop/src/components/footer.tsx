import Link from "next/link";

import { HalcyonMark } from "@/components/wordmark";

const COLUMNS = [
  {
    title: "Shop",
    links: [
      { href: "/shop?category=audio", label: "Audio" },
      { href: "/shop?category=home", label: "Home" },
      { href: "/shop?category=objects", label: "Objects" },
      { href: "/products/coffee-club", label: "Coffee Club" },
    ],
  },
  {
    title: "Help",
    links: [
      { href: "/#delivery", label: "Delivery and returns" },
      { href: "/#pay-over-time", label: "Pay over time" },
      { href: "/cart", label: "Your bag" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="mt-24 bg-ink text-paper sm:mt-32">
      {/* Room under the last line for the floating "Built with Polaris" button. */}
      <div className="mx-auto max-w-[1440px] px-4 pb-24 pt-16 sm:px-6 lg:px-10 lg:pt-24">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr_1fr]">
          <div className="max-w-md">
            <p className="display text-[2.4rem] leading-[1.05] sm:text-[3rem]">Fewer things, made to be used for a decade.</p>
            <p className="mt-5 text-[0.95rem] leading-relaxed text-paper/70">
              Halcyon makes headphones, lamps, chairs and the small objects that sit around them. Free delivery over $150, returns within
              30 days, and a two-year warranty on everything.
            </p>
          </div>
          {COLUMNS.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <h2 className="text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-paper/55">{column.title}</h2>
              <ul className="mt-2 sm:mt-4 sm:space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="inline-flex min-h-11 items-center text-[1rem] text-paper/90 transition-colors hover:text-paper sm:min-h-0">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-20 flex flex-col gap-6 border-t border-paper/15 pt-8 text-[0.85rem] text-paper/60 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-2.5 text-paper">
            <HalcyonMark size={20} />
            <span className="display text-[1.25rem]">Halcyon</span>
          </div>
          <p className="max-w-xl sm:text-right">
            Halcyon is a demonstration store. Orders are paid in test mode on Monad testnet, and nothing is ever shipped.
          </p>
        </div>
      </div>
    </footer>
  );
}

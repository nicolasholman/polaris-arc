import type { Metadata } from "next";
import Link from "next/link";

import { ProductCard } from "@/components/product-card";
import { CATEGORIES, PRODUCTS, type Category } from "@/lib/catalog";

export const metadata: Metadata = { title: "Shop" };

const FILTERS: { id: Category | "all"; label: string }[] = [
  { id: "all", label: "Everything" },
  ...CATEGORIES.map((c) => ({ id: c.id, label: c.name })),
];

export default async function ShopPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { category } = await searchParams;
  const active = CATEGORIES.some((c) => c.id === category) ? (category as Category) : "all";
  const products = active === "all" ? PRODUCTS : PRODUCTS.filter((p) => p.category === active);
  const heading = active === "all" ? "Everything we make" : CATEGORIES.find((c) => c.id === active)!.name;
  const blurb =
    active === "all"
      ? "Eight things, made carefully. Free delivery on orders over $150."
      : CATEGORIES.find((c) => c.id === active)!.blurb;

  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-12 sm:px-6 lg:px-10 lg:pt-20">
      <h1 className="display text-[3rem] sm:text-[4.2rem] lg:text-[5rem]">{heading}</h1>
      <p className="mt-4 max-w-[32rem] text-[1.05rem] text-muted">{blurb}</p>

      <nav aria-label="Categories" className="-mx-4 mt-10 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex gap-2">
          {FILTERS.map((filter) => {
            const current = filter.id === active;
            return (
              <li key={filter.id}>
                <Link
                  href={filter.id === "all" ? "/shop" : `/shop?category=${filter.id}`}
                  aria-current={current ? "page" : undefined}
                  className={`inline-flex h-10 items-center whitespace-nowrap rounded-full px-4 text-[0.92rem] transition-colors ${
                    current ? "bg-ink text-paper" : "text-ink-2 shadow-[inset_0_0_0_1px_var(--color-hair-strong)] hover:text-ink hover:shadow-[inset_0_0_0_1px_var(--color-ink)]"
                  }`}
                >
                  {filter.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Four across: the eight products fill two rows, with no empty cell. */}
      <div className="mt-10 grid grid-cols-2 gap-x-4 gap-y-12 sm:gap-x-6 lg:grid-cols-4 lg:gap-y-16">
        {products.map((product, i) => (
          <ProductCard
            key={product.id}
            product={product}
            priority={i < 4}
            revealDelay={(i % 4) * 80}
            sizes="(min-width: 1024px) 23vw, 50vw"
          />
        ))}
      </div>
    </div>
  );
}

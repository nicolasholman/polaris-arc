import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChevronDownIcon, ReturnIcon, TruckIcon } from "@/components/icons";
import { ProductCard } from "@/components/product-card";
import { ProductGallery } from "@/components/product-gallery";
import { PurchasePanel } from "@/components/purchase-panel";
import { PRODUCTS, categoryName, getProductBySlug } from "@/lib/catalog";
import { formatUsd } from "@/lib/money";
import { creditGuard, payInFourApr } from "@/lib/polaris";
import { pausedMessage } from "@/lib/polaris-config";
import { PolarisMessaging } from "@/lib/polaris-client";

export function generateStaticParams() {
  return PRODUCTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const product = getProductBySlug((await params).slug);
  return product ? { title: product.name, description: product.tagline } : {};
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const product = getProductBySlug((await params).slug);
  if (!product) notFound();

  const related = PRODUCTS.filter((p) => p.id !== product.id && !p.recurring)
    .sort((a, b) => Number(b.category === product.category) - Number(a.category === product.category))
    .slice(0, 3);
  const subscription = Boolean(product.recurring);
  const aprBps = payInFourApr();
  const paused = pausedMessage(await creditGuard());

  return (
    <>
      <div className="mx-auto max-w-[1440px] px-4 pt-6 sm:px-6 lg:px-10 lg:pt-10">
        <nav aria-label="Breadcrumb" className="-my-2 text-[0.88rem] text-muted">
          <ol className="flex items-center gap-2">
            <li>
              <Link href="/shop" className="inline-block py-2 hover:text-ink">
                Shop
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href={subscription ? "/products/coffee-club" : `/shop?category=${product.category}`} className="inline-block py-2 hover:text-ink">
                {categoryName(product.category)}
              </Link>
            </li>
          </ol>
        </nav>

        <div className="mt-5 grid gap-10 lg:mt-8 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-7">
            <ProductGallery product={product} />
          </div>

          <div className="lg:col-span-5 lg:pt-4">
            <h1 className="display text-[2.8rem] leading-[1] sm:text-[3.6rem] lg:text-[4rem]">{product.name}</h1>
            <p className="mt-4 text-[1.1rem] leading-relaxed text-ink-2">{product.tagline}</p>

            <p className="num mt-7 text-[1.6rem] tracking-[-0.01em]">
              {formatUsd(product.price)}
              {subscription ? <span className="text-[1.1rem] text-muted"> a month</span> : null}
            </p>
            {subscription ? (
              <p className="mt-2 text-[0.95rem] text-muted">Delivery included, billed monthly.</p>
            ) : (
              <PolarisMessaging amount={(product.price / 100).toFixed(2)} aprBps={aprBps} paused={paused} className="mt-2 text-ink-2" />
            )}

            <PurchasePanel product={product} aprBps={aprBps} />

            <ul className="mt-6 space-y-2 text-[0.92rem] text-muted">
              <li className="flex items-center gap-2.5">
                <TruckIcon size={18} className="text-sage" />
                {subscription
                  ? "Ships the first week of every month"
                  : (product.delivery ?? (product.price >= 15000 ? "Free delivery in 2 to 4 days" : "Delivery in 2 to 4 days, free over $150"))}
              </li>
              <li className="flex items-center gap-2.5">
                <ReturnIcon size={18} className="text-sage" />
                {subscription ? "Skip a month or cancel whenever you like" : "30 days to change your mind"}
              </li>
            </ul>

            <div className="mt-10 divide-y divide-hair border-y border-hair">
              <details className="group" open>
                <summary className="flex h-14 cursor-pointer list-none items-center justify-between font-medium [&::-webkit-details-marker]:hidden">
                  About it
                  <ChevronDownIcon size={18} className="transition-transform duration-300 group-open:rotate-180" />
                </summary>
                <div className="space-y-3 pb-6 text-[0.98rem] leading-relaxed text-ink-2">
                  {product.description.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </div>
              </details>
              <details className="group">
                <summary className="flex h-14 cursor-pointer list-none items-center justify-between font-medium [&::-webkit-details-marker]:hidden">
                  Specifications
                  <ChevronDownIcon size={18} className="transition-transform duration-300 group-open:rotate-180" />
                </summary>
                <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2.5 pb-6 text-[0.95rem]">
                  {product.specs.map((spec) => (
                    <div key={spec.label} className="contents">
                      <dt className="text-muted">{spec.label}</dt>
                      <dd className="text-ink-2">{spec.value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
              <details className="group">
                <summary className="flex h-14 cursor-pointer list-none items-center justify-between font-medium [&::-webkit-details-marker]:hidden">
                  Delivery and returns
                  <ChevronDownIcon size={18} className="transition-transform duration-300 group-open:rotate-180" />
                </summary>
                <p className="pb-6 text-[0.95rem] leading-relaxed text-ink-2">
                  Orders over $150 ship free; everything else ships for $9. Send anything back unused within 30 days for a full refund, and
                  every Halcyon product carries a two-year warranty.
                </p>
              </details>
            </div>
          </div>
        </div>
      </div>

      <section aria-labelledby="related-title" className="mx-auto max-w-[1440px] px-4 pt-24 sm:px-6 lg:px-10 lg:pt-32">
        <h2 id="related-title" className="display text-[2.2rem] sm:text-[2.8rem]">
          Pairs well with
        </h2>
        <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-3">
          {related.map((p, i) => (
            <ProductCard key={p.id} product={p} className={i === 2 ? "hidden lg:block" : ""} sizes="(min-width: 1024px) 30vw, 50vw" revealDelay={i * 90} />
          ))}
        </div>
      </section>
    </>
  );
}

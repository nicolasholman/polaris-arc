import Image from "next/image";
import Link from "next/link";

import { ImageReveal } from "@/components/reveal";
import type { Product } from "@/lib/catalog";
import { formatPrice } from "@/lib/money";

export function ProductCard({
  product,
  sizes = "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw",
  priority = false,
  aspect = "aspect-[4/5]",
  className = "",
  revealDelay = 0,
}: {
  product: Product;
  sizes?: string;
  priority?: boolean;
  aspect?: string;
  className?: string;
  revealDelay?: number;
}) {
  return (
    <Link href={`/products/${product.slug}`} className={`group block rounded-sm ${className}`}>
      <ImageReveal delay={revealDelay}>
      <div className={`tile relative overflow-hidden ${aspect}`}>
        <Image
          src={product.image}
          alt={product.imageAlt}
          fill
          sizes={sizes}
          loading={priority ? "eager" : "lazy"}
          className="object-cover transition-transform duration-[1200ms] ease-[var(--ease-out-expo)] group-hover:scale-[1.035] motion-reduce:transition-none"
        />
        {product.badge ? (
          <span className="absolute left-3 top-3 rounded-full bg-paper/90 px-2.5 py-1 text-[0.72rem] font-semibold tracking-[0.02em] text-ink">
            {product.badge}
          </span>
        ) : null}
      </div>
      </ImageReveal>
      <div className="mt-3.5 flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[1.02rem] font-medium leading-snug text-ink">{product.name}</h3>
          <p className="mt-0.5 truncate text-[0.9rem] text-muted">{product.tagline}</p>
        </div>
        <p className="num shrink-0 text-[1.02rem] text-ink">
          {formatPrice(product.price)}
          {product.recurring ? <span className="text-muted"> /mo</span> : null}
        </p>
      </div>
    </Link>
  );
}

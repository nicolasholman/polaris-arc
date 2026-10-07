"use client";

import Image from "next/image";
import Link from "next/link";

import { QuantityStepper } from "@/components/quantity";
import { FLAT_SHIPPING, FREE_SHIPPING_THRESHOLD } from "@/lib/catalog";
import { formatUsd } from "@/lib/money";
import { PolarisMessaging } from "@/lib/polaris-client";
import { pausedMessage } from "@/lib/polaris-config";
import { MAX_QUANTITY, useShop } from "@/lib/shop-context";

export function CartView() {
  const { lines, subtotal, count, ready, setQuantity, remove, polarisConfig } = useShop();
  const shipping = subtotal === 0 || subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_SHIPPING;
  const total = subtotal + shipping;

  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-12 sm:px-6 lg:px-10 lg:pt-20">
      <h1 className="display text-[3rem] sm:text-[4.2rem]">
        Your bag {ready && count > 0 ? <span className="num text-muted">({count})</span> : null}
      </h1>

      {!ready ? (
        <div className="mt-12 h-40" aria-busy="true" />
      ) : lines.length === 0 ? (
        <div className="mt-10 max-w-md">
          <p className="text-[1.08rem] text-muted">Your bag is empty. The autumn edit is a good place to start.</p>
          <Link href="/shop" className="btn btn-ink mt-8">
            Shop the collection
          </Link>
        </div>
      ) : (
        <div className="mt-10 grid gap-12 lg:grid-cols-12 lg:gap-16">
          <ul className="divide-y divide-hair border-y border-hair lg:col-span-7">
            {lines.map((line) => (
              <li key={`${line.productId}:${line.optionId}`} className="flex gap-5 py-6 sm:gap-7">
                <Link href={`/products/${line.product.slug}`} className="tile relative aspect-[4/5] w-[112px] shrink-0 overflow-hidden rounded-sm sm:w-[150px]">
                  <Image src={line.product.image} alt={line.product.imageAlt} fill sizes="150px" className="object-cover" />
                </Link>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                    <div>
                      <Link href={`/products/${line.product.slug}`} className="text-[1.1rem] font-medium hover:underline">
                        {line.product.name}
                      </Link>
                      <p className="text-[0.92rem] text-muted">
                        {line.product.optionLabel}: {line.option.label}
                      </p>
                    </div>
                    <p className="num text-[1.05rem]">{formatUsd(line.lineTotal)}</p>
                  </div>
                  <div className="mt-auto flex items-center gap-5 pt-4">
                    <QuantityStepper
                      size="sm"
                      label="Quantity"
                      value={line.quantity}
                      max={MAX_QUANTITY}
                      onChange={(q) => setQuantity(line.productId, line.optionId, q)}
                    />
                    <button type="button" className="link -mx-2 inline-flex min-h-11 items-center px-2 text-[0.9rem] text-muted" onClick={() => remove(line.productId, line.optionId)}>
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <aside aria-labelledby="summary-title" className="lg:col-span-5">
            <div className="rounded-[4px] bg-paper p-6 shadow-[0_1px_0_var(--color-hair)] sm:p-8 lg:sticky lg:top-24">
              <h2 id="summary-title" className="display text-[1.8rem]">
                Summary
              </h2>
              <dl className="mt-6 space-y-3 text-[0.98rem]">
                <div className="flex justify-between">
                  <dt className="text-ink-2">Subtotal</dt>
                  <dd className="num">{formatUsd(subtotal)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-2">Delivery</dt>
                  <dd className="num">{shipping === 0 ? "Free" : formatUsd(shipping)}</dd>
                </div>
                <div className="flex justify-between border-t border-hair pt-4 text-[1.15rem] font-medium">
                  <dt>Total</dt>
                  <dd className="num">{formatUsd(total)}</dd>
                </div>
              </dl>
              {polarisConfig.ok ? (
                <PolarisMessaging amount={(total / 100).toFixed(2)} aprBps={polarisConfig.payInFourAprBps} paused={pausedMessage(polarisConfig.creditGuard)} className="mt-4 text-ink-2 [--polaris-message-size:0.93rem]" />
              ) : null}
              <Link href="/checkout" className="btn btn-ink mt-7 w-full">
                Check out
              </Link>
              <p className="mt-4 text-center text-[0.85rem] text-muted">Prices include taxes. Returns within 30 days.</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

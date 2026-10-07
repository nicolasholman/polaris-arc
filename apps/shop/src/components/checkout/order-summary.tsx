"use client";

import Image from "next/image";

import { ChevronDownIcon } from "@/components/icons";
import type { Product, ProductOption } from "@/lib/catalog";
import { formatUsd } from "@/lib/money";
import { payIn4 } from "@/lib/pay-in-4";

import type { Mode } from "./payment-options";

export interface SummaryLine {
  productId: string;
  optionId: string;
  quantity: number;
  product: Product;
  option: ProductOption;
  lineTotal: number;
}

function Body({ lines, subtotal, shipping, total, mode, aprBps }: Omit<Props, "collapsible">) {
  const plan = mode === "later" ? payIn4(total, aprBps) : null;
  const subscription = lines.some((l) => l.product.recurring);
  return (
    <>
      <ul className="space-y-4">
        {lines.map((line) => (
          <li key={`${line.productId}:${line.optionId}`} className="flex items-center gap-4">
            <div className="tile relative h-[72px] w-[60px] shrink-0 overflow-hidden rounded-[3px]">
              <Image src={line.product.image} alt="" fill sizes="60px" className="object-cover" />
              {line.quantity > 1 ? (
                <span className="num absolute right-1 top-1 grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1 text-[0.72rem] text-paper">
                  {line.quantity}
                </span>
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium leading-snug">{line.product.name}</p>
              <p className="text-[0.88rem] text-muted">
                {line.option.label}
                {line.quantity > 1 ? ` · ${line.quantity} × ${formatUsd(line.product.price)}` : ""}
              </p>
            </div>
            <p className="num text-[0.98rem]">
              {formatUsd(line.lineTotal)}
              {line.product.recurring ? <span className="text-muted"> /mo</span> : null}
            </p>
          </li>
        ))}
      </ul>
      <dl className="mt-6 space-y-2.5 border-t border-hair pt-5 text-[0.96rem]">
        <div className="flex justify-between">
          <dt className="text-ink-2">Subtotal</dt>
          <dd className="num">{formatUsd(subtotal)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-2">Delivery</dt>
          <dd className="num">{shipping === 0 ? "Free" : formatUsd(shipping)}</dd>
        </div>
        <div className="flex items-baseline justify-between border-t border-hair pt-4">
          <dt className="text-[1.08rem] font-medium">{subscription ? "Due today" : "Total"}</dt>
          <dd className="num text-[1.35rem] font-medium tracking-[-0.01em]">{formatUsd(total)}</dd>
        </div>
      </dl>
      {plan ? (
        <p className="num mt-3 rounded-lg bg-sand px-3.5 py-2.5 text-[0.9rem] text-ink-2">
          With Pay in 4: nothing today, then 4 weekly payments of {formatUsd(plan.each)} (
          {`${formatUsd(plan.total)} including ${formatUsd(plan.interest)} interest`}).
        </p>
      ) : null}
      {subscription ? <p className="mt-3 text-[0.9rem] text-muted">Then {formatUsd(total)} every month. Skip or cancel any time.</p> : null}
    </>
  );
}

type Props = {
  lines: SummaryLine[];
  subtotal: number;
  shipping: number;
  total: number;
  mode: Mode | null;
  aprBps: number;
  collapsible?: boolean;
};

export function OrderSummary(props: Props) {
  if (props.collapsible) {
    return (
      <details className="group rounded-[4px] bg-paper shadow-[0_1px_0_var(--color-hair)]">
        <summary className="flex h-14 cursor-pointer list-none items-center justify-between px-4 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2 text-[0.95rem]">
            Order summary
            <ChevronDownIcon size={16} className="transition-transform duration-300 group-open:rotate-180" />
          </span>
          <span className="num font-medium">{formatUsd(props.total)}</span>
        </summary>
        <div className="px-4 pb-5">
          <Body {...props} />
        </div>
      </details>
    );
  }
  return (
    <div className="rounded-[4px] bg-paper p-6 shadow-[0_1px_0_var(--color-hair)] sm:p-8">
      <h2 className="display text-[1.8rem]">Your order</h2>
      <div className="mt-6">
        <Body {...props} />
      </div>
    </div>
  );
}

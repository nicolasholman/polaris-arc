"use client";

import { Button, type ButtonSize, type ButtonVariant } from "@polaris/ui";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import { useDemoShopUrl } from "@/lib/demo-shop";
import { DEMO_SHOP_SOON } from "@/lib/features";

/**
 * "See the demo shop": Halcyon (apps/shop), a storefront that pays through
 * polarispay-sdk with Pay now, Pay in 4 and direct wallet pay. It runs on
 * http://127.0.0.1:3600 in development (disabled when it isn't running);
 * NEXT_PUBLIC_DEMO_SHOP_URL points it at a deployed one, and without it a
 * production build shows the button disabled.
 */
export function DemoShopButton({
  label,
  icon,
  variant = "outline",
  size = "lg",
  className,
}: {
  label: string;
  icon?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const DEMO_SHOP_URL = useDemoShopUrl();
  if (!DEMO_SHOP_URL) {
    return (
      <Button variant={variant} size={size} icon={icon} disabled className={className}>
        {DEMO_SHOP_SOON}
      </Button>
    );
  }
  return (
    <Button asChild variant={variant} size={size} icon={icon} iconRight={<ArrowUpRight />} className={className}>
      <a href={DEMO_SHOP_URL} target="_blank" rel="noreferrer">
        {label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </Button>
  );
}

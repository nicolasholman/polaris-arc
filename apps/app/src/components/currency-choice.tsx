"use client";

import { Coin, DollarCoin, SegmentedControl } from "@polaris/ui";
import { eurosAvailable } from "@/lib/actions";
import { useData } from "@/lib/data/hooks";
import type { Currency } from "@/lib/money";

/**
 * Whether this network takes euro send links: EURC and the PolarisSend
 * deployed on it, as Polaris for Business reports them (`contracts.sendEurc`).
 * False while it loads and wherever they aren't deployed (a local chain).
 */
export function useEuroLinks(): boolean {
  const euros = useData(() => eurosAvailable(), []);
  return euros.value === true;
}

/** Dollars or euros, for a send link. Shown only where euro links exist. */
export function CurrencyChoice({
  value,
  onChange,
  className,
}: {
  value: Currency;
  onChange: (currency: Currency) => void;
  className?: string;
}) {
  return (
    <SegmentedControl<Currency>
      aria-label="Send in"
      size="sm"
      value={value}
      onValueChange={onChange}
      options={[
        { value: "USD", label: "Dollars" },
        { value: "EUR", label: "Euros" },
      ]}
      className={className}
    />
  );
}

/** The round coin for a currency: the dollar's blue "$", the euro's purple "€". */
export function CurrencyCoin({ currency, size = 42 }: { currency: Currency; size?: number }) {
  return currency === "EUR" ? (
    <Coin tone="purple" size={size}>
      <span className="-mt-[0.04em]">€</span>
    </Coin>
  ) : (
    <DollarCoin size={size} />
  );
}

"use client";

import type { MiniCard } from "@polaris/ui";
import { Layers, Sparkles } from "lucide-react";
import { getBalance, getBoost, getCreditLine } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { useOwner } from "@/lib/account/hooks";
import { type HomeAccount, setPrefs, usePrefs } from "@/lib/prefs";
import { n } from "@/lib/view";
import { AccountMark } from "./avatars";

export type AccountView = MiniCard & {
  id: HomeAccount;
  /** The Home card's pill ("Main account ▾"). */
  pill: string;
  /** What the figure is ("Available", "Locked"). */
  caption: string;
  last4: string;
};

/**
 * The account's number as a buyer sees it: four digits, like a bank card's,
 * worked out from the account (never its hex tail). No account, no digits.
 * The three faces share it: the Pay later line and Boost are the same
 * account's, not accounts of their own with numbers of their own.
 */
export function accountDigits(owner: string | null): string {
  if (!owner) return "····";
  return String(parseInt(owner.slice(-8), 16) % 10000).padStart(4, "0");
}

/**
 * The account's three faces (refs A and D): the Dollar account you pay and
 * send from, the Pay later line, and Boost (dollars locked in CollateralVault
 * to raise the line, read from the chain). A network without the vault has
 * no Boost. Home shows the one picked in Select account.
 */
export function useAccounts() {
  const owner = useOwner();
  const balance = useData(() => getBalance(owner), [owner]);
  const credit = useData(() => getCreditLine(owner), [owner]);
  const boost = useData(() => getBoost(owner), [owner]);
  const { homeAccount } = usePrefs();
  const last4 = accountDigits(owner);

  const ready = balance.value !== undefined && credit.value !== undefined && boost.value !== undefined;
  const accounts: AccountView[] = ready
    ? [
        {
          id: "dollar",
          mark: <AccountMark size={20} />,
          title: "Dollar account",
          pill: "Main account",
          caption: "Available",
          balance: n(balance.value!.available),
          last4,
          tint: "#2d3a1f",
        },
        {
          id: "later",
          mark: <Layers size={18} strokeWidth={1.75} className="text-ui-lime" />,
          title: "Pay later line",
          pill: "Pay later",
          caption: `Available of ${Math.round(n(credit.value!.limit)).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}`,
          balance: n(credit.value!.available),
          last4,
          tint: "#2e283e",
        },
        ...(boost.value
          ? [
              {
                id: "boost" as const,
                mark: <Sparkles size={18} strokeWidth={1.75} className="text-ui-yellow" />,
                title: "Boost",
                pill: "Boost",
                caption: "Locked to raise your line",
                balance: n(boost.value.locked),
                last4,
                tint: "#3f273d",
              },
            ]
          : []),
      ]
    : [];

  return {
    accounts,
    selected: accounts.find((a) => a.id === homeAccount) ?? accounts[0],
    select: (id: HomeAccount) => setPrefs({ homeAccount: id }),
    balance: balance.value,
    credit: credit.value,
    /** Undefined while loading; null when the network has no Boost. */
    boost: boost.value,
  };
}

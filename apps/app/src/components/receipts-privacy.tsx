"use client";

import { Badge, ListRow } from "@polaris/ui";
import type { ReactNode } from "react";
import type { AccountSource } from "@/lib/account";

/**
 * Settings' one line on receipts: a Face ID account's purchases are sealed
 * to it (Polaris stores them and can't read them); an email account has no
 * Face ID key to seal to, so its receipts are kept as they always were, and
 * this says so plainly.
 */
export function ReceiptsPrivacyRow({ source, icon }: { source: AccountSource; icon: ReactNode }) {
  const sealed = source !== "privy";
  return (
    <ListRow
      icon={icon}
      title="Receipts only you can read"
      description={
        sealed
          ? "What you buy is sealed to your Face ID. Polaris keeps it, but can't read it."
          : "Email accounts can't seal receipts: Polaris can read what you bought. Face ID accounts seal them."
      }
      trailing={<Badge tone={sealed ? "up" : "neutral"}>{sealed ? "On" : "Off"}</Badge>}
    />
  );
}

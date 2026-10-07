"use client";

import { Button, DetailsList, MiniCardCarousel, Money, Sheet, Skeleton } from "@polaris/ui";
import { Sparkles } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState, Suspense } from "react";
import { useAccounts } from "@/components/accounts";
import { BoostSheet } from "@/components/boost-sheet";
import { RouteSheet, useCloseSheet } from "@/components/shell/sheet-host";
import { boostPerDollar, boostTerms } from "@/lib/boost";
import { usd } from "@/lib/money";
import type { HomeAccount } from "@/lib/prefs";

const ABOUT: Record<HomeAccount, string> = {
  dollar: "Where you get paid, pay in full and send from.",
  later: "What Pay in 4 can use at checkout. It grows as you pay on time.",
  boost: "Dollars you lock to raise your Pay later line.",
};

/** Select account (half): ref A's card carousel, the chosen account's details, and which one Home shows. */
export function AccountsSheet() {
  const close = useCloseSheet();
  const asked = useSearchParams().get("account");
  const { accounts, selected, select, credit, boost } = useAccounts();
  const [picked, setPicked] = useState<HomeAccount | null>(
    asked === "dollar" || asked === "later" || asked === "boost" ? asked : null,
  );
  const current = accounts.find((a) => a.id === (picked ?? selected?.id)) ?? accounts[0];
  const [boosting, setBoosting] = useState(false);

  if (!current) {
    return (
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width={108} height={104} className="rounded-[16px]" />
          ))}
        </div>
        <Skeleton shape="tile" height={160} />
      </Sheet.Body>
    );
  }

  const onHome = selected?.id === current.id;
  // Null while the vault or ScoreManager's face-value rule is unknown: then no row names a figure.
  const terms = boostTerms(boost, credit);

  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
        <MiniCardCarousel aria-label="Accounts" cards={accounts} value={current.id} onValueChange={(id) => setPicked(id as HomeAccount)} />
        <div>
          <p className="text-[14px] text-ui-muted">{current.caption}</p>
          <Money value={current.balance} dim="symbol" className="mt-1 text-[40px] leading-none font-semibold tracking-[-0.035em]" />
          <p className="mt-2 text-[15px] leading-[1.45] text-ui-muted">{ABOUT[current.id]}</p>
        </div>
        <DetailsList
          size="sm"
          items={[
            { label: "Number", value: `**** ${current.last4}` },
            current.id === "later" && credit
              ? { label: "Interest", value: `${credit.aprBps / 100}% a year` }
              : current.id === "boost" && terms
                ? { label: "Each $1 adds", value: `${usd(boostPerDollar(terms))} of limit` }
                : { label: "Currency", value: "US dollars" },
            current.id === "later" && credit ? { label: "In use", value: usd(credit.used) } : { label: "Fees", value: "None" },
          ]}
        />
      </Sheet.Body>
      <Sheet.Footer className="lg:[&>*]:flex-1">
        {current.id === "boost" ? (
          <Button variant="lime" size="lg" icon={<Sparkles />} onClick={() => setBoosting(true)}>
            Add to Boost
          </Button>
        ) : null}
        <Button
          variant={current.id === "boost" ? "dark" : "lime"}
          size="lg"
          disabled={onHome}
          onClick={() => {
            select(current.id);
            close();
          }}
        >
          {onHome ? "On Home now" : "Show on Home"}
        </Button>
      </Sheet.Footer>
      <BoostSheet open={boosting} onOpenChange={setBoosting} />
    </>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function AccountsRoute({ cold }: { cold?: boolean }) {
  return (
    <RouteSheet label="Select account" title="Select account" snapPoints={[560]} cold={cold} fallback="/cards">
      <Suspense>
        <AccountsSheet />
      </Suspense>
    </RouteSheet>
  );
}

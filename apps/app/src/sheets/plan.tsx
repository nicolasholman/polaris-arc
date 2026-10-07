"use client";

import { Button, DetailsList, EmptyState, KeyValueGrid, ScreenHeader, Sheet, Skeleton, TxRow } from "@polaris/ui";
import { CalendarX } from "lucide-react";
import { useEffect, useState } from "react";
import { MerchantAvatar } from "@/components/avatars";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { SignAgainCard } from "@/components/sign-again";
import { RouteSheet, useCloseSheet } from "@/components/shell/sheet-host";
import { SuccessSheet } from "@/components/success-sheet";
import { PlanDrawerContent } from "@/desktop/plans";
import { payEarly } from "@/lib/actions";
import { useOwner } from "@/lib/account/hooks";
import { describeInterval, dueAt, getPlans } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { longDate, relativeDay, shortDate } from "@/lib/dates";
import { prefetchDomains } from "@/lib/domains";
import { type Micros, usd } from "@/lib/money";
import type { RelayReceipt } from "@/lib/relayer";
import { n, planProgress } from "@/lib/view";

/** Plan detail (half, drag up to full), on ref C's details: the numbers, the four payments, Pay early. */
export function PlanSheet({ id }: { id: string }) {
  const close = useCloseSheet();
  const owner = useOwner();
  const plans = useData(() => getPlans(owner), [owner]);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState<{ receipt: RelayReceipt; amount: Micros } | null>(null);

  useEffect(() => prefetchDomains("payments"), []);

  if (!plans.value) {
    return (
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-2">
        <Skeleton shape="tile" height={64} />
        <div className="grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} shape="tile" height={72} />
          ))}
        </div>
      </Sheet.Body>
    );
  }

  const plan = plans.value.plans.find((p) => p.id === id);
  if (!plan) {
    return (
      <Sheet.Body>
        <EmptyState size="sm" icon={<CalendarX />} title="This plan isn't here" description="It may belong to another account on this device." />
      </Sheet.Body>
    );
  }

  const p = planProgress(plan);
  const total = plan.principal + plan.interest;
  const paidSoFar = total - p.left;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        variant="arrow"
        title={plan.merchant.name}
        subtitle={plan.status === "active" ? `Pay in 4 · ${p.done} of ${p.total} paid` : "Pay in 4 · paid off"}
        logo={<MerchantAvatar name={plan.merchant.name} size="sm" />}
        onBack={close}
        className="-mt-2 shrink-0 px-5"
      />
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-1">
        <SignAgainCard plan={plan} plans={plans.value.plans} />
        <KeyValueGrid
          items={[
            { label: "Amount", value: usd(plan.principal) },
            { label: "Pay in 4", value: `${usd(plan.instalments[0]?.amount ?? 0n)} × ${p.total}` },
            { label: "Interest", value: usd(plan.interest) },
            // Nothing is due when a plan opens: payment 1 is one interval later.
            { label: "First payment", value: shortDate(plan.instalments[0]?.dueAt ?? dueAt(plan.openedAt, plan.interval, 0)) },
            { label: "Paid so far", value: usd(paidSoFar) },
            { label: "Left to pay", value: usd(p.left) },
          ]}
        />
        <DetailsList
          items={[
            { label: "Merchant", value: plan.merchant.name },
            { label: "For", value: plan.description },
            { label: "Schedule", value: describeInterval(plan.interval).replace(/^every/, "Every") },
            { label: "Opened", value: longDate(plan.openedAt) },
          ]}
        />
        <h3 className="mt-2 px-1 text-[14px] font-medium text-ui-muted">Payments</h3>
        <div className="flex flex-col gap-2">
          {plan.instalments.map((inst) => {
            const isNext = inst === p.next;
            return (
              <TxRow
                key={inst.index}
                static
                variant="card"
                leading={<MerchantAvatar name={plan.merchant.name} />}
                title={`Payment ${inst.index + 1} of ${p.total}`}
                subtitle={inst.paidAt !== null ? `Paid ${shortDate(inst.paidAt)}` : isNext ? `Next, ${relativeDay(inst.dueAt)}` : `Due ${shortDate(inst.dueAt)}`}
                value={
                  <span className={inst.paidAt !== null ? "text-ui-up" : isNext ? "text-ui-text" : "text-ui-muted"}>
                    {usd(inst.amount)}
                  </span>
                }
              />
            );
          })}
        </div>
      </Sheet.Body>
      {p.next ? (
        <Sheet.Footer>
          <Button variant="lime" size="lg" onClick={() => setPaying(true)}>
            Pay {usd(p.next.amount)} early
          </Button>
        </Sheet.Footer>
      ) : null}

      {p.next ? (
        <ConfirmSheet
          open={paying}
          onOpenChange={setPaying}
          title={`Pay ${usd(p.next.amount)} early`}
          summary={`Your next payment to ${plan.merchant.name}, due ${relativeDay(p.next.dueAt)}. Paying early costs nothing extra.`}
          busyLabel="Paying…"
          onAccount={async (signer) => {
            const amount = p.next!.amount;
            const receipt = await payEarly(signer, plan);
            setPaid({ receipt, amount });
          }}
        />
      ) : null}
      <SuccessSheet
        open={paid !== null}
        onOpenChange={(open) => !open && setPaid(null)}
        title="Paid early."
        subtitle={paid ? `${usd(paid.amount)} to ${plan.merchant.name}. ${n(p.left) > 0 ? `${usd(p.left)} left.` : "All paid off."}` : undefined}
        receiptUrl={paid?.receipt.explorerUrl}
      />
    </div>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function PlanRoute({ id, cold }: { cold?: boolean } & { id: string }) {
  return (
    <RouteSheet
      label="Plan details"
      snapPoints={["half", "full"]}
      cold={cold}
      fallback="/insights?view=plans"
      desktop={{ as: "drawer", title: "Plan details", content: <PlanDrawerContent id={id} /> }}
    >
      <PlanSheet id={id} />
    </RouteSheet>
  );
}

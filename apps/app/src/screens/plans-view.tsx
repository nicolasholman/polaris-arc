"use client";

import {
  AdaptiveSheet,
  AssetRow,
  Button,
  DetailsList,
  EmptyState,
  FeaturedTile,
  SectionHeader,
  Sheet,
  Skeleton,
  toast,
} from "@polaris/ui";
import { CalendarClock, Repeat } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MerchantAvatar, merchantBrand } from "@/components/avatars";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { cancelSubscription } from "@/lib/actions";
import { useOwner } from "@/lib/account/hooks";
import { describeInterval, getPlans, type Subscription } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { relativeDay, shortDate } from "@/lib/dates";
import { prefetchDomains } from "@/lib/domains";
import { usd } from "@/lib/money";
import { planProgress } from "@/lib/view";

/** Plans (Insights → Plans): Pay in 4 as ref B's featured tiles, then subscriptions and what's paid off. */
export function PlansView() {
  const router = useRouter();
  const owner = useOwner();
  const plans = useData(() => getPlans(owner), [owner]);
  const [managing, setManaging] = useState<Subscription | null>(null);

  useEffect(() => prefetchDomains("payments"), []);

  if (!plans.value) {
    return (
      <div className="mt-5 flex flex-col gap-3">
        <div className="flex gap-3">
          <Skeleton shape="tile" width={168} height={176} />
          <Skeleton shape="tile" width={168} height={176} />
        </div>
        <Skeleton shape="row" height={72} />
        <Skeleton shape="row" height={72} />
      </div>
    );
  }

  const active = plans.value.plans.filter((p) => p.status === "active");
  const done = plans.value.plans.filter((p) => p.status === "completed");
  const subs = plans.value.subscriptions;

  return (
    <div className="mt-5 flex flex-col gap-4">
      <SectionHeader title="Pay in 4" />
      {active.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<CalendarClock />}
          title="No plans open"
          description="Choose Pay in 4 at checkout. Every payment and the total interest are shown first."
        />
      ) : (
        <div className="ui-no-scrollbar -mx-5 flex gap-3 overflow-x-auto px-5">
          {active.map((plan) => {
            const p = planProgress(plan);
            return (
              <FeaturedTile
                key={plan.id}
                leading={<MerchantAvatar name={plan.merchant.name} size="sm" />}
                title={plan.merchant.name}
                subtitle="Pay in 4"
                value={usd(p.left)}
                meta={p.next ? `Next ${shortDate(p.next.dueAt)}` : "Paid off"}
                progress={{ done: p.done, total: p.total }}
                tint={merchantBrand(plan.merchant.name).color}
                className="w-auto min-w-[168px] grow basis-0"
                aria-label={`${plan.merchant.name}, ${usd(p.left)} left, ${p.done} of ${p.total} paid`}
                onClick={() => router.push(`/plans/${plan.id}`, { scroll: false })}
              />
            );
          })}
        </div>
      )}

      <SectionHeader title="Subscriptions" className="mt-2" />
      {subs.length === 0 ? (
        <EmptyState size="sm" icon={<Repeat />} title="No subscriptions" description="Subscribe from a merchant's link. Cancel here any time." />
      ) : (
        <div className="flex flex-col gap-2">
          {subs.map((sub) => (
            <AssetRow
              key={sub.id}
              leading={<MerchantAvatar name={sub.merchant.name} />}
              title={sub.merchant.name}
              subtitle={sub.name}
              value={usd(sub.price)}
              meta={sub.status === "active" ? `Next ${shortDate(sub.nextChargeAt)}` : "Cancelled"}
              trend="flat"
              static={sub.status !== "active"}
              onClick={sub.status === "active" ? () => setManaging(sub) : undefined}
              aria-label={
                sub.status === "active" ? `${sub.merchant.name}, ${sub.name}, ${usd(sub.price)} ${describeInterval(sub.periodSeconds)}. Manage` : undefined
              }
            />
          ))}
        </div>
      )}

      {done.length ? (
        <>
          <SectionHeader title="Paid off" className="mt-2" />
          <div className="flex flex-col gap-2">
            {done.map((plan) => (
              <AssetRow
                key={plan.id}
                leading={<MerchantAvatar name={plan.merchant.name} />}
                title={plan.merchant.name}
                subtitle={plan.description}
                progress={{ done: plan.instalments.length, total: plan.instalments.length }}
                trend="up"
                value={usd(plan.principal + plan.interest)}
                meta="Paid in full"
                onClick={() => router.push(`/plans/${plan.id}`, { scroll: false })}
              />
            ))}
          </div>
        </>
      ) : null}

      <SubscriptionSheet sub={managing} onClose={() => setManaging(null)} />
    </div>
  );
}

/** "Oct 2, in 5 days", or just "Oct 18" when it is further off. */
function nextCharge(at: number): string {
  const rel = relativeDay(at);
  return rel.startsWith("on ") ? shortDate(at) : `${shortDate(at)}, ${rel}`;
}

/**
 * Manage a subscription (fit): what it costs and when it next charges, and
 * the one way out, which still asks for Face ID.
 */
export function SubscriptionSheet({ sub, onClose }: { sub: Subscription | null; onClose: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  // Keep the last one on screen while the sheet slides away.
  const [shown, setShown] = useState(sub);
  if (sub && sub !== shown) setShown(sub);
  const s = sub ?? shown;

  return (
    <AdaptiveSheet
      open={sub !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCancelling(false);
          onClose();
        }
      }}
      snapPoints={["fit"]}
      aria-label={s ? `${s.merchant.name} subscription` : "Subscription"}
      maxWidth={440}
    >
      {s ? (
        <>
          <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
            <div className="flex items-center gap-3">
              <MerchantAvatar name={s.merchant.name} />
              <div className="min-w-0">
                <h2 className="truncate text-[20px] leading-tight font-medium tracking-[-0.02em]">{s.merchant.name}</h2>
                <p className="truncate text-[14px] text-ui-muted">{s.name}</p>
              </div>
            </div>
            <DetailsList
              items={[
                { label: "Price", value: `${usd(s.price)} ${describeInterval(s.periodSeconds)}` },
                { label: "Next charge", value: nextCharge(s.nextChargeAt) },
                { label: "Since", value: shortDate(s.startedAt) },
                { label: "Paid from", value: "Your dollar account" },
              ]}
            />
          </Sheet.Body>
          <Sheet.Footer>
            <Button variant="outline" size="lg" onClick={onClose}>
              Done
            </Button>
            <Button variant="dark" size="lg" className="text-ui-down" onClick={() => setCancelling(true)}>
              Cancel subscription
            </Button>
          </Sheet.Footer>
          <ConfirmSheet
            open={cancelling}
            onOpenChange={setCancelling}
            title={`Cancel ${s.merchant.name}?`}
            summary={`${s.name}, ${usd(s.price)} ${describeInterval(s.periodSeconds)}. Nothing more will be charged.`}
            confirmLabel="Cancel with Face ID"
            busyLabel="Cancelling…"
            danger
            onAccount={async (signer) => {
              await cancelSubscription(signer, s.subId);
              toast({ title: `${s.merchant.name} is cancelled`, tone: "success" });
            }}
            onDone={onClose}
          />
        </>
      ) : null}
    </AdaptiveSheet>
  );
}

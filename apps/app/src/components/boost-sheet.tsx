"use client";

import { AdaptiveSheet, AmountDisplay, applyKey, Button, DetailsList, Keypad, SegmentedControl, Sheet } from "@polaris/ui";
import { ArrowDownToLine, Plus, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { addToBoost, takeOutOfBoost } from "@/lib/actions";
import { useAccountState } from "@/lib/account/hooks";
import { boostAmountProblem, boostDrop, boostRaise, boostTerms, takeOutProblem, takeOutState } from "@/lib/boost";
import { type Boost, getBalance, getBoost, getCreditLine } from "@/lib/data";
import { notifyDataChanged } from "@/lib/data/changes";
import { prefetchDomains } from "@/lib/domains";
import { type Micros, parseAmount, usd } from "@/lib/money";
import type { RelayReceipt } from "@/lib/relayer";
import { useAccounts } from "./accounts";
import { ConfirmSheet } from "./confirm-sheet";
import { SuccessSheet } from "./success-sheet";

export type BoostMode = "add" | "takeOut";

type Done = {
  mode: BoostMode;
  receipt: RelayReceipt;
  amount: Micros;
  /** Read from the chain after the relay: null when the vault didn't show it yet. */
  locked: Micros | null;
  limit: Micros | null;
  limitBefore: Micros | null;
  /** The dollar balance after a take-out, read back from the chain. */
  balance: Micros | null;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * After the relay: Boost, the limit and the dollar balance as the chain has
 * them now. The relayer answers once the block is in, but a slow receipt
 * comes back "submitted", so this reads `lockedOf` a few times until it shows
 * the change, then reads the limit (ScoreManager.creditLimitOf, through
 * Polaris for Business) and the balance fresh.
 */
async function readAfter(owner: Address, landed: (boost: Boost) => boolean): Promise<{ locked: Micros | null; limit: Micros | null; balance: Micros | null }> {
  for (let i = 0; i < 8; i++) {
    const boost = await getBoost(owner).catch(() => null);
    if (boost && landed(boost)) {
      notifyDataChanged(); // every screen, and the reads below, start from this block
      const [credit, balance] = await Promise.all([getCreditLine(owner).catch(() => null), getBalance(owner).catch(() => null)]);
      return { locked: boost.locked, limit: credit?.limit ?? null, balance: balance?.available ?? null };
    }
    await pause(1_000);
  }
  return { locked: null, limit: null, balance: null };
}

const COPY = {
  add: { title: "Add to Boost", description: "Lock dollars to raise your Pay later limit." },
  takeOut: { title: "Take out of Boost", description: "Move dollars from Boost back to your dollar account." },
} as const;

/**
 * Boost, both ways. Add: how much (the app's keypad), then one Face ID that
 * signs the dollar's permit to CollateralVault, which Polaris carries. Take
 * out: how much of what's free, then one Face ID that signs the vault's
 * Withdraw, which Polaris carries to `withdrawWithSig`; the vault pays the
 * account and nobody else, and only while no Pay in 4 plan is open. Then what
 * Boost, the Pay later limit (and, taken out, the balance) are now, read back
 * from the chain. On a network whose vault predates signed withdrawal, Take
 * out says it isn't available there yet (lib/boost.ts).
 */
export function BoostSheet({ open, onOpenChange, mode: initialMode = "add" }: { open: boolean; onOpenChange: (open: boolean) => void; mode?: BoostMode }) {
  const router = useRouter();
  const state = useAccountState();
  const { balance, credit, boost } = useAccounts();
  const [mode, setMode] = useState<BoostMode>(initialMode);
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  // Each opening starts fresh, in the mode it was opened for.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMode(initialMode);
      setValue("");
      setDone(null);
    }
  }

  useEffect(() => {
    if (open) prefetchDomains("ausd");
  }, [open]);

  const amount = parseAmount(value || "0") ?? 0n;
  const available = balance?.available;
  // The vault's multiplier and ScoreManager's face-value rule; null while either is unknown.
  const terms = boostTerms(boost, credit);
  const adding = mode === "add";

  // Add
  const raise = terms && amount > 0n ? boostRaise(amount, terms) : null;
  // A device with no account yet has nothing to lock: Add money first.
  const empty = available === 0n || state.status === "none";
  const addProblem = value ? boostAmountProblem(amount, available) : null;

  // Take out
  const out = boost ? takeOutState(boost) : null;
  const drop = terms && amount > 0n && boost && amount <= boost.locked ? boostDrop(amount, terms) : null;
  const outProblem = value && boost ? takeOutProblem(amount, boost) : null;

  const problem = adding ? addProblem : outProblem;
  const tooMuch = adding ? available !== undefined && amount > available : boost ? amount > boost.withdrawable : false;
  const hint = problem
    ? problem
    : adding
      ? raise !== null
        ? `Raises your limit by ${usd(raise)}`
        : available !== undefined
          ? `Available ${usd(available)}`
          : " "
      : drop !== null && drop > 0n
        ? `Lowers your limit by ${usd(drop)}`
        : boost
          ? `Free to take out ${usd(boost.withdrawable)}`
          : " ";

  const switchTo = (next: BoostMode) => {
    setMode(next);
    setValue("");
  };

  const close = () => {
    setDone(null);
    onOpenChange(false);
  };

  const keypadOpen = adding ? !empty : out === "ready";

  return (
    <>
      <AdaptiveSheet
        open={open && !done}
        onOpenChange={(next) => !confirming && onOpenChange(next)}
        snapPoints={["full"]}
        title={COPY[mode].title}
        description={COPY[mode].description}
        maxWidth={440}
      >
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-1">
          <SegmentedControl
            aria-label="Add or take out"
            block
            size="sm"
            value={mode}
            onValueChange={switchTo}
            options={[
              { value: "add", label: "Add" },
              { value: "takeOut", label: "Take out" },
            ]}
          />
          <DetailsList
            size="sm"
            items={[
              { label: "In Boost", value: boost ? usd(boost.locked) : "…" },
              ...(adding ? [] : [{ label: "Free to take out", value: boost ? usd(boost.withdrawable) : "…" }]),
              { label: "Pay later limit", value: credit ? usd(credit.limit) : "…" },
            ]}
          />
          {adding && empty ? (
            <>
              <p className="text-[15px] leading-[1.45] text-ui-muted">
                Boost locks dollars from your account. Your balance is {usd(available ?? 0n)}: add money first, then come back to Boost.
              </p>
              <Button
                variant="lime"
                size="lg"
                block
                icon={<Plus />}
                onClick={() => {
                  onOpenChange(false);
                  router.push("/add", { scroll: false });
                }}
              >
                Add money
              </Button>
            </>
          ) : null}
          {!adding && out !== "ready" ? (
            <p role="status" className="text-[15px] leading-[1.45] text-ui-muted">
              {out === "unsupported"
                ? "Taking them out isn't available on this network yet. Boost dollars stay yours, locked in Boost."
                : out === "empty"
                  ? "Nothing is in Boost yet."
                  : out === "in-use"
                    ? "Your Boost secures your Pay in 4 plan, so it stays in until the plan is paid off. Then you can take it all out."
                    : " "}
            </p>
          ) : null}
          {keypadOpen ? (
            <>
              <div className="flex min-h-[112px] flex-1 items-center justify-center">
                <AmountDisplay value={value} invalid={tooMuch} hint={<span className={problem ? "text-ui-down" : undefined}>{hint}</span>} />
              </div>
              <Button
                variant="lime"
                size="xl"
                block
                icon={adding ? <Sparkles /> : <ArrowDownToLine />}
                disabled={amount === 0n || problem !== null}
                onClick={() => setConfirming(true)}
              >
                {adding ? "Add to Boost" : "Take out"}
              </Button>
              <Keypad onKey={(k) => setValue((v) => applyKey(v, k))} onClear={() => setValue("")} captureKeyboard={open && !confirming && !done} />
              <p className="text-center text-[13px] leading-[1.45] text-ui-muted">
                {adding
                  ? boost?.takeOut
                    ? "Boost dollars stay yours. Take them out whenever no Pay in 4 plan is open."
                    : "Boost dollars stay yours. Taking them out isn't available on this network yet."
                  : "It goes back to your dollar account. No network fee."}
              </p>
            </>
          ) : null}
        </Sheet.Body>
      </AdaptiveSheet>

      <ConfirmSheet
        open={confirming}
        onOpenChange={setConfirming}
        title={adding ? `Add ${usd(amount, { trim: true })} to Boost` : `Take ${usd(amount, { trim: true })} out of Boost`}
        summary={
          adding ? (
            <>
              It moves from your dollar account into Boost, where it raises your Pay later limit
              {raise !== null ? ` by ${usd(raise, { trim: true })}` : ""}.
              {boost?.takeOut ? " You can take it out again whenever no Pay in 4 plan is open." : " Taking it out isn't available on this network yet."}
            </>
          ) : (
            <>
              It moves from Boost back to your dollar account
              {drop !== null && drop > 0n ? `, and your Pay later limit goes down by ${usd(drop, { trim: true })}` : ""}.
            </>
          )
        }
        busyLabel={adding ? "Adding…" : "Taking out…"}
        onAccount={async (signer) => {
          const lockedBefore = boost?.locked ?? 0n;
          const limitBefore = credit?.limit ?? null;
          if (adding) {
            const receipt = await addToBoost(signer, amount, { balance: available });
            const after = await readAfter(signer.address, (b) => b.locked >= lockedBefore + amount);
            setDone({ mode, receipt, amount, ...after, limitBefore });
          } else {
            if (!boost) throw new Error("Boost isn't loaded yet. Try again.");
            const receipt = await takeOutOfBoost(signer, amount, boost);
            const after = await readAfter(signer.address, (b) => b.locked <= lockedBefore - amount);
            setDone({ mode, receipt, amount, ...after, limitBefore });
          }
        }}
      />

      <SuccessSheet
        open={done !== null}
        onOpenChange={(o) => !o && close()}
        title={done?.mode === "takeOut" ? "Taken out." : "Boosted."}
        subtitle={done ? successLine(done) : undefined}
        receiptUrl={done?.receipt.explorerUrl}
        rows={
          done
            ? [
                { label: done.mode === "takeOut" ? "Taken out" : "Added", value: usd(done.amount) },
                { label: "In Boost", value: done.locked !== null ? usd(done.locked) : "Updating…" },
                {
                  label: "Pay later limit",
                  value:
                    done.limit === null
                      ? "Updating…"
                      : done.limitBefore !== null && done.limitBefore !== done.limit
                        ? `${usd(done.limitBefore)} → ${usd(done.limit)}`
                        : usd(done.limit),
                },
                ...(done.mode === "takeOut" ? [{ label: "Dollar account", value: done.balance !== null ? usd(done.balance) : "Updating…" }] : []),
                { label: "Network fee", value: "None" },
              ]
            : []
        }
        primary={{ label: "Done", onClick: close }}
      />
    </>
  );
}

function successLine(done: Done): string {
  const amount = usd(done.amount, { trim: true });
  if (done.mode === "takeOut") {
    return done.limit !== null
      ? `${amount} is back in your dollar account. Your Pay later limit is ${usd(done.limit, { trim: true })} now.`
      : `${amount} is on its way back to your dollar account. Your limit updates here when it lands.`;
  }
  return done.limit !== null
    ? `${amount} is in Boost. Your Pay later limit is ${usd(done.limit, { trim: true })} now.`
    : `${amount} is on its way to Boost. Your limit updates here when it lands.`;
}

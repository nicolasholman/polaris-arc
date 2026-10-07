"use client";

import { AdaptiveSheet, Button, DetailsList, ListGroup, ListRow, Sheet } from "@polaris/ui";
import { Clock, Globe, ScanFace, ShieldCheck, Wallet } from "lucide-react";
import { useState } from "react";
import { createAccount, describeAccountError, toAccountError } from "@/lib/account";
import { useAccountState } from "@/lib/account/hooks";
import type { CreditLine, CreditReason } from "@/lib/data";
import { usd } from "@/lib/money";
import { bringHistory, LOCAL_HISTORY_WALLET } from "@/lib/underwriting";
import { ReasonLabel } from "./reason-label";

/**
 * The reasons "Your limit went up" lists: every one a data provider stands
 * behind (Nansen), then the strongest others, three or more in all.
 */
export function limitReasons(reasons: CreditReason[]): CreditReason[] {
  const positive = reasons.filter((r) => r.points > 0);
  const sourced = positive.filter((r) => r.source);
  const others = positive.filter((r) => !r.source).slice(0, Math.max(2, 3 - sourced.length));
  return positive.filter((r) => sourced.includes(r) || others.includes(r));
}

/** What a failed raise says: the account's own sentence for Face ID problems, the review's reason otherwise. */
function raiseError(error: unknown): string {
  const account = toAccountError(error);
  if (account.kind !== "unknown") return describeAccountError(account);
  return error instanceof Error && error.message ? error.message : "We couldn't raise your limit this time.";
}

/**
 * "Raise your limit": the one optional step that may say "wallet", because
 * it exists for people who already have one (plan §2, §5.5).
 */
export function BringHistorySheet({
  open,
  onOpenChange,
  credit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credit: CreditLine | undefined;
}) {
  const [state, setState] = useState<"idle" | "working" | "done" | "reviewing">("idle");
  // A buyer who opened a link on a new phone has no account yet: the same tap creates it.
  const account = useAccountState();
  const newBuyer = account.status === "none";
  const [error, setError] = useState<string | null>(null);
  // Each opening starts fresh.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setState("idle");
      setError(null);
    }
  }

  const done = state === "done" && credit;
  return (
    <AdaptiveSheet
      open={open}
      onOpenChange={(next) => state !== "working" && onOpenChange(next)}
      dismissible={state !== "working"}
      snapPoints={["half", "full"]}
      title={done ? "Your limit went up" : "Raise your limit"}
      description={done ? undefined : "We read the history of a wallet you already use. Nothing moves from it."}
      maxWidth={440}
    >
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
        {done ? (
          <>
            <p className="ui-figure text-[40px] leading-none font-semibold tracking-[-0.035em]">{usd(credit.limit, { trim: true })}</p>
            <p className="-mt-2 text-[15px] text-ui-muted">is your Pay later limit now.</p>
            <DetailsList
              size="sm"
              wrapLabels
              items={limitReasons(credit.reasons).map((r) => ({ label: <ReasonLabel reason={r} />, value: <span className="text-ui-up">+{r.points}</span> }))}
            />
          </>
        ) : state === "reviewing" ? (
          <p role="status" className="text-[15px] leading-[1.45] text-ui-muted">
            Your review is still running. Your limit updates here by itself when it lands; nothing else to do.
          </p>
        ) : (
          <>
            <ListGroup label="What we look at">
              <ListRow icon={<Clock />} title="How long it has been in use" />
              <ListRow icon={<Globe />} title="Where its money came from" />
              <ListRow icon={<ShieldCheck />} title="How long it has held dollars" />
            </ListGroup>
            {credit ? (
              <p className="text-[14px] leading-[1.45] text-ui-muted">
                New limits start at $200 and go up to {usd(credit.openingCap, { trim: true })}. Paying on time raises them from there.
              </p>
            ) : null}
            {LOCAL_HISTORY_WALLET ? (
              <p className="text-[13px] leading-[1.45] text-ui-warn">
                Local demo: with no wallet in this browser, a stand-in wallet signs. Its history is read from the live providers, so it starts empty.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-[14px] leading-[1.45] text-ui-down">
                {error}
              </p>
            ) : null}
          </>
        )}
      </Sheet.Body>
      <Sheet.Footer>
        {done || state === "reviewing" ? (
          <Button variant="lime" size="lg" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <Button
            variant="lime"
            size="lg"
            icon={newBuyer ? <ScanFace /> : <Wallet />}
            loading={state === "working"}
            disabled={credit?.historyLinked}
            onClick={async () => {
              setState("working");
              setError(null);
              try {
                // Face ID starts inside the tap (WebKit wants it in the gesture). It creates the account; the review then reuses that session.
                if (newBuyer) await createAccount();
                setState((await bringHistory()) === "applied" ? "done" : "reviewing");
              } catch (e) {
                setError(raiseError(e));
                setState("idle");
              }
            }}
          >
            {credit?.historyLinked ? "History already linked" : newBuyer ? "Continue with Face ID" : "Connect your wallet"}
          </Button>
        )}
      </Sheet.Footer>
    </AdaptiveSheet>
  );
}

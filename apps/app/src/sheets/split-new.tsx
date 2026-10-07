"use client";

import {
  AmountDisplay,
  applyKey,
  Button,
  DetailsList,
  IconButton,
  Input,
  Keypad,
  Notice,
  PrimaryButton,
  ScreenHeader,
  SecondaryButton,
  SegmentedControl,
  Sheet,
  SuccessCheck,
  Toggle,
  toast,
  useIsDesktop,
} from "@polaris/ui";
import { Copy, Minus, Plus, Share2, UserPlus, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { zeroAddress } from "viem";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { LocalEquivalent } from "@/components/local-equivalent";
import { QrCode } from "@/components/qr";
import { SenderNameField } from "@/components/sender-name";
import { RouteSheet, useCloseSheet } from "@/components/shell/sheet-host";
import { type CreatedSplit, createSplit } from "@/lib/actions";
import { useOwner } from "@/lib/account/hooks";
import { getProfile } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { longDate } from "@/lib/dates";
import { getDomain, prefetchDomains } from "@/lib/domains";
import { parseAmount, usd } from "@/lib/money";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { cleanText, MAX_PEOPLE, planSplit, type SplitMemo, type SplitMode, type SplitRow, splitPrefill } from "@/lib/split";

/**
 * Split a bill: the organiser enters what was paid, says what it was for,
 * and splits it equally between some number of people (named or not), or by
 * named amounts. One Face ID opens the split; the link goes to everyone.
 *
 * "Equally" counts everyone who shares the bill; with "Include me" on (the
 * default), the organiser's own share is theirs and only the friends' shares
 * are collected. "By amount" collects exactly the amounts named; what's left
 * of the bill is the organiser's part.
 *
 * On a phone: the keypad for the bill, then the details. From 1024px: one
 * form in the Dialog, in ref E's controls.
 */

type Mode = SplitMode;
type Row = SplitRow;

/** Digits and one point, at most two decimals: what an amount field accepts. */
function cleanAmount(raw: string): string {
  const s = raw.replace(/[^\d.]/g, "");
  const [whole = "", ...rest] = s.split(".");
  if (!rest.length) return whole.slice(0, 9);
  return `${whole.slice(0, 9)}.${rest.join("").slice(0, 2)}`;
}

/** The form's state, shared by the phone's two steps and the desktop's one form. */
function useSplitForm() {
  // An app can open this form filled in (polarispay-sdk `splits.link()`); the organiser still reviews it all.
  const params = useSearchParams();
  const [prefill] = useState(() => splitPrefill(new URLSearchParams(params?.toString() ?? "")));
  const [value, setValue] = useState(prefill.amount ?? "");
  const [description, setDescription] = useState(prefill.description ?? "");
  const [mode, setMode] = useState<Mode>(prefill.mode ?? "equal");
  const [people, setPeople] = useState(prefill.people ?? 3);
  const [includeMe, setIncludeMe] = useState(prefill.includeMe ?? true);
  const [names, setNames] = useState<string[]>(prefill.names ?? []);
  const [rows, setRows] = useState<Row[]>(
    prefill.rows ?? [
      { name: "", amount: "" },
      { name: "", amount: "" },
    ],
  );
  const bill = parseAmount(value || "0") ?? 0n;
  const plan = useMemo(() => planSplit({ bill, mode, people, includeMe, names, rows }), [bill, mode, people, includeMe, names, rows]);
  return { value, setValue, description, setDescription, mode, setMode, people, setPeople, includeMe, setIncludeMe, names, setNames, rows, setRows, bill, plan };
}

type Form = ReturnType<typeof useSplitForm>;

/**
 * Whether this network has PolarisSplit: false on a deployment that predates
 * it (the API reports no split contract), so the form says so before anyone
 * fills it in. null while it's being read, or if it can't be; the confirm
 * then says so instead.
 */
function useSplitAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    getDomain("split")
      .then((d) => live && setAvailable(d.verifyingContract !== zeroAddress))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return available;
}

/** Create a split, on a phone: the keypad, then the details. */
export function SplitNewSheet() {
  const close = useCloseSheet();
  const form = useSplitForm();
  // A filled-in bill (a link from another app) starts on the details.
  const [step, setStep] = useState<"amount" | "details">(form.bill > 0n ? "details" : "amount");
  useEffect(() => prefetchDomains("split"), []);

  if (step === "amount") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ScreenHeader title="Split a bill" onBack={close} className="-mt-2 shrink-0 px-5" />
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-[max(16px,env(safe-area-inset-bottom))]">
          <p className="text-center text-[15px] text-ui-muted">What did the bill come to?</p>
          <div className="flex min-h-[112px] flex-1 items-center justify-center">
            <AmountDisplay value={form.value} hint={<LocalEquivalent amount={form.bill} className="text-[13px]" />} />
          </div>
          <Button variant="lime" size="xl" block disabled={form.bill === 0n} onClick={() => setStep("details")}>
            Next
          </Button>
          <Keypad onKey={(k) => form.setValue((v) => applyKey(v, k))} onClear={() => form.setValue("")} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader title={`Split ${usd(form.bill, { trim: true })}`} onBack={() => setStep("amount")} className="-mt-2 shrink-0 px-5" />
      <SplitDetails form={form} onDone={close} />
    </div>
  );
}

/** Create a split, from 1024px: one form in the Dialog. */
export function SplitNewDialogContent() {
  const close = useCloseSheet();
  const form = useSplitForm();
  useEffect(() => prefetchDomains("split"), []);
  return <SplitDetails form={form} onDone={close} withAmount />;
}

function SplitDetails({ form, onDone, withAmount = false }: { form: Form; onDone: () => void; withAmount?: boolean }) {
  const router = useRouter();
  const desktop = useIsDesktop();
  const owner = useOwner();
  const profile = useData(() => getProfile(owner), [owner]);
  const prefs = usePrefs();
  const [confirming, setConfirming] = useState(false);
  const [nameField, setNameField] = useState("");
  const [created, setCreated] = useState<CreatedSplit | null>(null);
  const available = useSplitAvailable();
  const { plan, mode } = form;
  const canCreate = plan.ok && available !== false;
  const organiserName = prefs.name || profile.value?.name || "";
  const friends = mode === "equal" ? Math.max(0, form.people - (form.includeMe ? 1 : 0)) : form.rows.length;

  if (created) {
    return (
      <LinkReady
        created={created}
        onDone={() => {
          onDone();
          // Straight to the split, where each share shows up as it lands.
          window.setTimeout(() => router.push(`/split/${created.splitId}`, { scroll: false }), 350);
        }}
      />
    );
  }

  const setName = (i: number, v: string) =>
    form.setNames((list) => {
      const next = [...list];
      next[i] = v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 24);
      return next;
    });
  const setRow = (i: number, patch: Partial<Row>) => form.setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
        {available === false ? (
          <Notice tone="neutral" title="Splitting a bill isn't available here yet">
            Paying, sending and everything else work as usual.
          </Notice>
        ) : null}
        {withAmount ? (
          <div className="grid gap-1.5">
            <Input
              label="The bill"
              inputMode="decimal"
              placeholder="0.00"
              size="lg"
              trailing="USD"
              value={form.value}
              onChange={(e) => form.setValue(cleanAmount(e.target.value))}
              onBlur={() => form.setValue((v) => (v && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : v))}
              autoFocus
            />
            <LocalEquivalent amount={form.bill} className="px-1 text-[13px]" />
          </div>
        ) : null}
        <Input
          label="What's it for"
          placeholder="Dinner at Lucia"
          maxLength={60}
          value={form.description}
          onChange={(e) => form.setDescription(e.target.value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 60))}
        />
        <SegmentedControl<Mode>
          aria-label="How to split it"
          block
          options={[
            { value: "equal", label: "Equally" },
            { value: "custom", label: "By amount" },
          ]}
          value={mode}
          onValueChange={form.setMode}
        />

        {mode === "equal" ? (
          <>
            <div className="flex items-center justify-between gap-3 rounded-ui-tile bg-ui-surface-1 p-4 lg:bg-ui-surface-2">
              <div>
                <p className="text-[15px] font-medium">People</p>
                <p className="text-[13px] text-ui-muted">{form.includeMe ? "Including you" : "Not counting you"}</p>
              </div>
              <div className="flex items-center gap-3">
                <IconButton
                  label="One fewer"
                  icon={<Minus />}
                  tone="surface"
                  disabled={form.people <= 2}
                  onClick={() => form.setPeople((p) => Math.max(2, p - 1))}
                />
                <span className="ui-figure w-8 text-center text-[22px] font-semibold" aria-live="polite">
                  {form.people}
                </span>
                <IconButton
                  label="One more"
                  icon={<Plus />}
                  tone="surface"
                  disabled={form.people >= MAX_PEOPLE}
                  onClick={() => form.setPeople((p) => Math.min(MAX_PEOPLE, p + 1))}
                />
              </div>
            </div>
            <Toggle
              checked={form.includeMe}
              onCheckedChange={form.setIncludeMe}
              label="I'm paying a share too"
              description="Your share stays with you; friends are asked for theirs."
            />
            <div className="grid gap-2">
              <p className="text-[14px] font-medium text-ui-muted">Friends&apos; names (optional)</p>
              {Array.from({ length: friends }, (_, i) => (
                <Input
                  key={i}
                  hideLabel
                  label={`Friend ${i + 1}'s name`}
                  placeholder={`Friend ${i + 1}`}
                  autoCapitalize="words"
                  value={form.names[i] ?? ""}
                  onChange={(e) => setName(i, e.target.value)}
                  trailing={plan.ok ? usd(plan.amounts[i] ?? 0n) : undefined}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="grid gap-2">
            {form.rows.map((row, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_120px_auto] items-center gap-2">
                <Input
                  hideLabel
                  label={`Friend ${i + 1}'s name`}
                  placeholder={`Friend ${i + 1}`}
                  autoCapitalize="words"
                  value={row.name}
                  onChange={(e) => setRow(i, { name: e.target.value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 24) })}
                />
                <Input
                  hideLabel
                  label={`What ${row.name.trim() || `friend ${i + 1}`} owes, in dollars`}
                  placeholder="0.00"
                  inputMode="decimal"
                  value={row.amount}
                  onChange={(e) => setRow(i, { amount: cleanAmount(e.target.value) })}
                />
                <IconButton
                  label={`Remove ${row.name.trim() || `friend ${i + 1}`}`}
                  icon={<X />}
                  tone="ghost"
                  disabled={form.rows.length <= 1}
                  onClick={() => form.setRows((list) => list.filter((_, j) => j !== i))}
                />
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              icon={<UserPlus />}
              className="justify-self-start"
              disabled={form.rows.length >= MAX_PEOPLE - 1}
              onClick={() => form.setRows((list) => [...list, { name: "", amount: "" }])}
            >
              Add a friend
            </Button>
          </div>
        )}

        {plan.ok ? (
          <DetailsList
            size="sm"
            items={[
              ...(plan.each !== null ? [{ label: "Each share", value: usd(plan.each) }] : []),
              { label: `From ${plan.amounts.length} ${plan.amounts.length === 1 ? "friend" : "friends"}`, value: usd(plan.collect) },
              { label: "Your part", value: usd(plan.yourPart) },
              { label: "Fee", value: "None" },
            ]}
          />
        ) : plan.reason ? (
          <p role="status" className="px-1 text-[14px] text-ui-down">
            {plan.reason}
          </p>
        ) : null}
      </Sheet.Body>
      <Sheet.Footer className="lg:[&>*]:flex-1">
        {desktop ? (
          <PrimaryButton size="lg" disabled={!canCreate} onClick={() => setConfirming(true)}>
            {plan.ok ? `Create link for ${usd(plan.collect, { trim: true })}` : "Create link"}
          </PrimaryButton>
        ) : (
          <Button variant="lime" size="lg" disabled={!canCreate} onClick={() => setConfirming(true)}>
            {plan.ok ? `Create link for ${usd(plan.collect, { trim: true })}` : "Create link"}
          </Button>
        )}
      </Sheet.Footer>

      {plan.ok ? (
        <ConfirmSheet
          open={confirming}
          onOpenChange={setConfirming}
          title={`Collect ${usd(plan.collect, { trim: true })}`}
          summary={
            <>
              {`${plan.amounts.length} ${plan.amounts.length === 1 ? "share" : "shares"} of ${form.description.trim() || "your bill"}. Each friend pays theirs from the link, and it lands with you straight away.`}
              {!prefs.name ? <SenderNameField value={nameField} onChange={setNameField} /> : null}
            </>
          }
          newLabel="Create with Face ID"
          busyLabel="Making your link…"
          onAccount={async (signer) => {
            const typed = nameField.trim();
            if (typed && !prefs.name) setPrefs({ name: typed });
            const memo: SplitMemo = {
              description: cleanText(form.description, 60),
              organiserName: cleanText(typed || organiserName || "A friend", 40),
              billTotal: form.bill,
              labels: plan.labels,
            };
            setCreated(await createSplit(signer, plan.amounts, memo, window.location.origin));
          }}
        />
      ) : null}
    </>
  );
}

/** The split is open: share its link, then watch the shares land. */
function LinkReady({ created, onDone }: { created: CreatedSplit; onDone: () => void }) {
  const desktop = useIsDesktop();
  const total = created.amounts.reduce((a, b) => a + b, 0n);
  const what = created.memo.description || "your bill";

  async function share() {
    const text = `${what}: your share is waiting. Pay it here, in a second.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: created.memo.description || "Split", text, url: created.url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await copy();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.url);
      toast({ title: "Link copied", tone: "success" });
    } catch {
      toast({ title: "Couldn't copy the link", tone: "error" });
    }
  }

  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-2 pt-4 text-center">
        <SuccessCheck label="Link ready" size={80} />
        <h2 className="mt-3 text-[34px] leading-none font-semibold tracking-[-0.035em]">Link ready.</h2>
        <p role="status" className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
          Share it with everyone in the split. Each share lands with you the moment it&apos;s paid.
        </p>
        <DetailsList
          size="sm"
          className="mt-3 w-full text-left"
          items={[
            { label: "For", value: created.memo.description || "Split" },
            { label: "To collect", value: usd(total) },
            { label: "Shares", value: String(created.amounts.length) },
            { label: "Open until", value: longDate(created.expiresAt) },
          ]}
        />
        <div className="mt-2 flex w-full flex-col items-center gap-3">
          <QrCode value={created.url} size={132} label="QR code of your split link" />
          <div className="grid w-full grid-cols-2 gap-2">
            {desktop ? (
              <SecondaryButton size="sm" icon={<Share2 />} className="bg-ui-surface-2 hover:bg-ui-surface-3" onClick={() => void share()}>
                Share link
              </SecondaryButton>
            ) : (
              <Button variant="white" size="md" icon={<Share2 />} onClick={() => void share()}>
                Share link
              </Button>
            )}
            <Button variant="dark" size="md" icon={<Copy />} className="lg:bg-ui-surface-2 lg:hover:bg-ui-surface-3" onClick={() => void copy()}>
              Copy
            </Button>
          </div>
        </div>
      </Sheet.Body>
      <Sheet.Footer className="lg:[&>*]:flex-1">
        {desktop ? (
          <PrimaryButton size="lg" onClick={onDone}>
            See your split
          </PrimaryButton>
        ) : (
          <Button variant="lime" size="lg" onClick={onDone}>
            See your split
          </Button>
        )}
      </Sheet.Footer>
    </>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over Home). */
export function SplitNewRoute({ cold }: { cold?: boolean }) {
  return (
    <RouteSheet
      label="Split a bill"
      snapPoints={["full"]}
      cold={cold}
      desktop={{
        as: "dialog",
        size: "md",
        title: "Split a bill",
        description: "One link: each friend pays their share, and it lands with you.",
        content: (
          <Suspense>
            <SplitNewDialogContent />
          </Suspense>
        ),
      }}
    >
      <Suspense>
        <SplitNewSheet />
      </Suspense>
    </RouteSheet>
  );
}

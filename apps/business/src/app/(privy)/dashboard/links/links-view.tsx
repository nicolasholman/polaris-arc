"use client";

import {
  Button,
  Chip,
  CopyButton,
  DataTable,
  Dialog,
  EmptyState,
  IconSquareButton,
  Input,
  Menu,
  Money,
  Notice,
  PrimaryButton,
  SecondaryButton,
  SegmentedControl,
  Select,
  StatusPill,
  TableName,
  TimeframeChips,
  toast,
  type StatusPillTone,
  type TableColumn,
} from "@polaris/ui";
import { ArrowUpRight, Ban, Copy, Link2, MoreHorizontal, Plus, Share2, SlidersHorizontal } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { LoadError, StaleNotice } from "@/components/dashboard/common";
import { MoneyWidget } from "@/components/dashboard/money-widget";
import { FigureRow, PageCoin, PageHead } from "@/components/dashboard/page-head";
import { ModeCoin } from "@/components/dashboard/payment-bits";
import { DownloadQrButton, QrCode } from "@/components/qr";
import { DataError, errorMessage } from "@/lib/data";
import { formatDate, MODE_LABEL, money, parseAmount, payInFourQuote } from "@/lib/data/format";
import type { LinkStatus, LinkUsage, PayMode, PaymentLink } from "@/lib/data/types";
import { useDashboardData, useQuery, useReadiness, type QueryState } from "@/lib/session";

const STATUS: Record<LinkStatus, { tone: StatusPillTone; label: string }> = {
  active: { tone: "lime", label: "Active" },
  used: { tone: "purple", label: "Used" },
  expired: { tone: "neutral", label: "Expired" },
  inactive: { tone: "neutral", label: "Off" },
};

const SHORT_MODE: Record<PayMode, string> = { now: "Now", later: "In 4", subscribe: "Monthly" };

type Filter = "all" | "active" | "closed";

export function LinksView() {
  const links = useQuery((d) => d.listLinks());
  const blocker = useReadiness().links;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<PaymentLink | null>(null);
  const [turningOff, setTurningOff] = useState<PaymentLink | null>(null);

  // `?new=1` (the nav's "New link", on this page too) opens the dialog each
  // time it appears, then leaves the URL.
  const wantsNew = params.get("new") === "1";
  const [seenNew, setSeenNew] = useState(false);
  if (wantsNew !== seenNew) {
    setSeenNew(wantsNew);
    if (wantsNew) setCreating(true);
  }
  useEffect(() => {
    if (wantsNew) router.replace(pathname, { scroll: false });
  }, [wantsNew, pathname, router]);

  const list = links.data;
  const counts = useMemo(() => ({ all: list?.length ?? 0, active: list?.filter((l) => l.status === "active").length ?? 0 }), [list]);
  const collected = useMemo(() => (list ? list.reduce((s, l) => s + l.collectedCents, 0) : undefined), [list]);
  const filtered = (list ?? []).filter((l) => (filter === "all" ? true : filter === "active" ? l.status === "active" : l.status !== "active"));
  const live = !blocker;

  const columns: TableColumn<PaymentLink>[] = [
    {
      key: "link",
      header: "Link",
      render: (l) => (
        <TableName
          icon={<ModeCoin mode={l.modes.includes("later") ? "later" : (l.modes[0] ?? "now")} text={l.description} />}
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{l.description}</span>
            </span>
          }
          sub={
            <>
              {/* On phones the Status column folds in here, like the app's activity rows. */}
              <span className="sm:hidden">{STATUS[l.status].label} · </span>
              {l.usage === "single" ? "Single use" : "Reusable"}
              {l.expiresAt ? ` · until ${formatDate(l.expiresAt)}` : ""}
            </>
          }
        />
      ),
    },
    {
      key: "ways",
      header: "Buyer can pay",
      // From 1280px: beside the Request widget the table has room for four columns.
      hideBelow: "xl",
      render: (l) => <span className="whitespace-nowrap text-ui-muted">{l.modes.map((m) => SHORT_MODE[m]).join(" · ")}</span>,
    },
    {
      key: "status",
      header: "Status",
      hideBelow: "sm",
      render: (l) => <StatusPill tone={STATUS[l.status].tone}>{STATUS[l.status].label}</StatusPill>,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      render: (l) => (
        <span className="flex flex-col items-end">
          <span className="ui-figure font-medium">{money(l.amountCents)}</span>
          <span className="ui-figure text-[13px] whitespace-nowrap text-ui-muted">
            {l.paymentsCount} paid<span className="hidden sm:inline"> · {money(l.collectedCents)}</span>
          </span>
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (l) => <LinkActions link={l} live={live} onShare={() => setSharing(l)} onTurnOff={() => setTurningOff(l)} />,
    },
  ];

  return (
    <>
      <PageHead
        title="Payment links"
        coins={[
          <PageCoin key="l" tone="teal">
            <Link2 />
          </PageCoin>,
          <PageCoin key="d" tone="blue">
            <span className="text-[26px] font-bold">$</span>
          </PageCoin>,
        ]}
        actions={<IconSquareButton label="New payment link" icon={<Plus />} tone="solid" active onClick={() => setCreating(true)} />}
      />
      <StaleNotice queries={[links as QueryState<unknown>]} />
      {blocker ? (
        <Notice id="links-pending" tone="info" className="mb-5" title="Buyers can't open links yet">
          {blocker} You can create links now; sharing, copying and QR codes switch on then.
        </Notice>
      ) : null}

      {/* The Overview's layout from 1024px; on phones the Request widget comes first. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_356px] xl:grid-cols-[minmax(0,1fr)_404px] xl:gap-x-11">
        <section aria-label="Your payment links" className="min-w-0">
          <FigureRow
            caption="Collected through your links"
            value={collected === undefined ? undefined : <Money value={collected / 100} />}
            deltaLabel={list ? `${counts.active} active` : undefined}
            right={
              <TimeframeChips<Filter>
                aria-label="Filter links"
                options={[
                  { value: "all", label: `All ${counts.all}` },
                  { value: "active", label: `Active ${counts.active}` },
                  { value: "closed", label: `Closed ${counts.all - counts.active}` },
                ]}
                value={filter}
                onValueChange={setFilter}
              />
            }
          />
          <p className="mt-3 max-w-[560px] text-[15px] leading-relaxed text-ui-muted">
            One link, three ways to pay: in full, in four payments on Polaris credit, or by subscription. You&rsquo;re paid in full either way.
          </p>

          <div className="mt-6">
            {links.error && !list ? (
              <LoadError query={links as QueryState<unknown>} title="We couldn't load your links" />
            ) : list && filtered.length === 0 ? (
              <EmptyState
                icon={<Link2 />}
                title={list.length ? "Nothing here" : "No payment links yet"}
                description={
                  list.length ? "No links match this filter." : "Create one for an invoice, a product or a service. Buyers choose how to pay; you're paid in full."
                }
                action={
                  list.length ? null : (
                    <PrimaryButton size="sm" icon={<Plus />} onClick={() => setCreating(true)}>
                      New link
                    </PrimaryButton>
                  )
                }
              />
            ) : (
              <DataTable caption="Payment links" loading={!list} loadingRows={6} columns={columns} rows={filtered} rowKey={(l) => l.id} />
            )}
          </div>
        </section>

        <aside aria-label="Request a payment" className="order-first grid min-w-0 content-start gap-3 md:max-w-[480px] lg:order-none lg:max-w-none">
          <MoneyWidget
            defaultTab="request"
            onLinkCreated={(link) => {
              links.mutate((current) => [link, ...(current ?? [])]);
              setFilter("all");
            }}
            requestSecondary={
              <SecondaryButton size="lg" block iconRight={<SlidersHorizontal />} onClick={() => setCreating(true)}>
                More options
              </SecondaryButton>
            }
          />
        </aside>
      </div>

      <NewLinkDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(link) => {
          links.mutate((current) => [link, ...(current ?? [])]);
          setFilter("all");
        }}
      />
      <ShareDialog link={blocker ? null : sharing} onClose={() => setSharing(null)} />
      <TurnOffDialog
        link={turningOff}
        onClose={() => setTurningOff(null)}
        onDone={(link) => links.mutate((current) => current?.map((l) => (l.id === link.id ? link : l)))}
      />
    </>
  );
}

function LinkActions({ link, live, onShare, onTurnOff }: { link: PaymentLink; live: boolean; onShare: () => void; onTurnOff: () => void }) {
  const active = link.status === "active";
  const why = "Once buyers can open links";
  const copy = () =>
    navigator.clipboard
      .writeText(link.url)
      .then(() => toast({ title: "Link copied", tone: "success" }))
      .catch(() => toast({ title: "We couldn't copy the link", description: link.url, tone: "error" }));
  return (
    <span className="inline-flex items-center gap-2">
      <IconSquareButton
        size="sm"
        className="hidden sm:inline-grid"
        label={live ? `Share “${link.description}”` : "Sharing opens once buyers can open links"}
        icon={<Share2 />}
        onClick={onShare}
        disabled={!live || !active}
        aria-describedby={live ? undefined : "links-pending"}
      />
      <Menu
        label={`More for “${link.description}”`}
        align="end"
        width={260}
        triggerClassName="rounded-[12px] active:scale-100"
        trigger={
          <span className="grid size-9 place-items-center rounded-[12px] border border-ui-hairline-strong bg-ui-square text-[#a7a9ad] transition-colors hover:text-ui-text">
            <MoreHorizontal aria-hidden size={17} strokeWidth={1.75} />
          </span>
        }
      >
        <Menu.Item
          icon={<Share2 />}
          className="sm:hidden"
          disabled={!live || !active}
          description={live ? undefined : why}
          onSelect={onShare}
        >
          Share
        </Menu.Item>
        <Menu.Item
          icon={<Copy />}
          disabled={!live || !active}
          description={live ? undefined : why}
          onSelect={() => void copy()}
        >
          Copy link
        </Menu.Item>
        <Menu.Item
          icon={<Ban />}
          tone="danger"
          disabled={!active}
          onSelect={onTurnOff}
          description={active ? "It stops taking payments" : "Already closed"}
        >
          Turn off
        </Menu.Item>
      </Menu>
    </span>
  );
}

/* ── New link ───────────────────────────────────────────────────────────── */

const EXPIRY = [
  { value: "never", label: "Never", hours: null },
  { value: "24h", label: "In 24 hours", hours: 24 },
  { value: "7d", label: "In 7 days", hours: 24 * 7 },
  { value: "30d", label: "In 30 days", hours: 24 * 30 },
] as const;

type ExpiryKey = (typeof EXPIRY)[number]["value"];
type Errors = Partial<Record<"description" | "amountCents" | "modes" | "usage" | "expiresInHours" | "form", string>>;

function NewLinkDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (link: PaymentLink) => void;
}) {
  const data = useDashboardData();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [modes, setModes] = useState<PayMode[]>(["now", "later"]);
  const [usage, setUsage] = useState<LinkUsage>("reusable");
  const [expiry, setExpiry] = useState<ExpiryKey>("never");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  const cents = parseAmount(amount);
  const quote = cents && cents >= 20_00 ? payInFourQuote(cents) : null;

  const reset = () => {
    setDescription("");
    setAmount("");
    setModes(["now", "later"]);
    setUsage("reusable");
    setExpiry("never");
    setErrors({});
  };

  const toggle = (m: PayMode) => {
    const next = modes.includes(m) ? modes.filter((x) => x !== m) : [...modes, m];
    setModes(next);
    // A subscription charges every month: it needs a link that stays open.
    if (next.includes("subscribe")) setUsage("reusable");
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    if (!description.trim()) next.description = "Say what the buyer is paying for.";
    if (cents === null) next.amountCents = "Enter an amount, like 200 or 49.50.";
    if (!modes.length) next.modes = "Choose at least one way to pay.";
    if (modes.includes("later") && cents !== null && cents < 20_00) next.modes = "Pay in 4 needs at least $20.00.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const link = await data.createLink({
        description: description.trim(),
        amountCents: cents!,
        modes,
        usage,
        expiresInHours: EXPIRY.find((x) => x.value === expiry)!.hours,
      });
      onCreated(link);
      toast({
        title: "Link saved",
        description: "Share it from its row: a link, a QR code, or the checkout itself.",
        tone: "success",
      });
      onOpenChange(false);
      reset();
    } catch (err) {
      const field = err instanceof DataError ? err.field : undefined;
      setErrors({ [field && field in { description: 1, amountCents: 1, modes: 1, usage: 1, expiresInHours: 1 } ? field : "form"]: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New payment link" description="Buyers choose how to pay; you're paid in full either way.">
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <Dialog.Body className="grid grid-cols-[minmax(0,1fr)] gap-5">
          <Input
            label="What it's for"
            placeholder="Brand identity package"
            maxLength={120}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={errors.description}
            hint="Buyers see this on the checkout and the receipt."
          />
          <Input
            label="Amount"
            placeholder="200.00"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={errors.amountCents}
            trailing="USD"
            hint={quote ? `Pay in 4: 4 × ${money(quote.each)} at 10% APR, paid by the buyer. You get ${money(cents!)} at checkout.` : undefined}
          />
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[14px] font-medium text-ui-muted">Ways to pay</legend>
            <div className="flex flex-wrap gap-2">
              {(["now", "later", "subscribe"] as const).map((m) => (
                <Chip key={m} variant="pill" selected={modes.includes(m)} onClick={() => toggle(m)}>
                  {MODE_LABEL[m]}
                </Chip>
              ))}
            </div>
            {errors.modes ? (
              <p role="alert" className="text-[13px] text-ui-down">
                {errors.modes}
              </p>
            ) : (
              <p className="text-[13px] text-ui-muted">Subscribe charges the amount every month until the buyer cancels.</p>
            )}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <span className="text-[14px] font-medium text-ui-muted" id="usage-label">
                Use
              </span>
              <SegmentedControl<LinkUsage>
                aria-labelledby="usage-label"
                block
                value={usage}
                onValueChange={setUsage}
                options={[
                  { value: "reusable", label: "Reusable" },
                  { value: "single", label: "Single use", disabled: modes.includes("subscribe") },
                ]}
              />
              {modes.includes("subscribe") ? <p className="text-[13px] text-ui-muted">Subscriptions need a reusable link.</p> : null}
            </div>
            <Select<ExpiryKey>
              label="Expires"
              variant="filled"
              value={expiry}
              onValueChange={setExpiry}
              options={EXPIRY.map((x) => ({ value: x.value, label: x.label }))}
            />
          </div>
          {errors.form ? (
            <Notice tone="down" size="sm" role="alert">
              {errors.form}
            </Notice>
          ) : null}
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <PrimaryButton type="submit" loading={busy} icon={<Plus />}>
            Create link
          </PrimaryButton>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}

/* ── Share (only once buyers can open links) ─────────────────────────────── */

function ShareDialog({ link, onClose }: { link: PaymentLink | null; onClose: () => void }) {
  const [last, setLast] = useState(link);
  if (link && link !== last) setLast(link);
  const l = link ?? last;
  return (
    <Dialog open={link !== null} onOpenChange={(o) => !o && onClose()} size="sm" title="Share link" description={l?.description}>
      {l ? (
        <Dialog.Body className="grid justify-items-center gap-5">
          <QrCode value={l.url} label={`QR code for ${l.description}`} size={200} />
          <div className="flex w-full min-w-0 items-center gap-2 rounded-ui-field bg-ui-surface-2 p-1.5 pl-4">
            <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{l.url}</code>
            <CopyButton value={l.url} label="link" variant="button" buttonVariant="lime" />
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <DownloadQrButton value={l.url} filename={`polaris-${l.id}.svg`} />
            <Button asChild variant="outline" size="sm" icon={<ArrowUpRight />}>
              <a href={l.url} target="_blank" rel="noreferrer">
                Open checkout
              </a>
            </Button>
          </div>
        </Dialog.Body>
      ) : null}
    </Dialog>
  );
}

/* ── Turn off ───────────────────────────────────────────────────────────── */

function TurnOffDialog({ link, onClose, onDone }: { link: PaymentLink | null; onClose: () => void; onDone: (l: PaymentLink) => void }) {
  const data = useDashboardData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState(link);
  if (link && link !== last) setLast(link);
  const l = link ?? last;

  const confirm = async () => {
    if (!l) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await data.deactivateLink(l.id);
      onDone(updated);
      toast({ title: "Link turned off", tone: "success" });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={link !== null} onOpenChange={(o) => !o && onClose()} size="sm" title="Turn off this link?" description={l?.description}>
      <Dialog.Body className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <p className="text-[15px] leading-relaxed text-ui-muted">
          Buyers who open it will see it no longer takes payments. Payments already made, and Pay in 4 plans still collecting,
          aren&rsquo;t affected. This can&rsquo;t be undone; you can create a new link instead.
        </p>
        {error ? (
          <Notice tone="down" size="sm" role="alert">
            {error}
          </Notice>
        ) : null}
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" onClick={onClose}>
          Keep it on
        </Button>
        <Button variant="white" loading={busy} icon={<Ban />} onClick={confirm} className="bg-ui-down text-white hover:bg-ui-down/90">
          Turn off
        </Button>
      </Dialog.Footer>
    </Dialog>
  );
}


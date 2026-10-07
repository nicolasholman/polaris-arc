"use client";

import {
  Button,
  Chip,
  CodeBlock,
  CopyButton,
  DetailsList,
  Dialog,
  Drawer,
  EmptyState,
  IconSquareButton,
  Input,
  Menu,
  Notice,
  PanelCard,
  PolarisCoin,
  PrimaryButton,
  SecondaryButton,
  Skeleton,
  StatusPill,
  toast,
  type StatusPillTone,
} from "@polaris/ui";
import { Check, CodeXml, KeyRound, MoreHorizontal, Plus, RotateCcw, Send, ShoppingBag, Store, Trash2, TriangleAlert, Webhook } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { LoadError, Panel, StaleNotice, useNow } from "@/components/dashboard/common";
import { RegistrationBadge, registrationOf, useRegisterAction } from "@/components/dashboard/registration";
import { developers as sdk } from "@/components/landing/content";
import { DemoShopButton } from "@/components/landing/demo-shop";
import { PageCoin, PageHead } from "@/components/dashboard/page-head";
import { DataError, errorMessage, WEBHOOK_EVENTS, type ApiKey, type WebhookDelivery, type WebhookEndpoint, type WebhookEventType } from "@/lib/data";
import { formatAgo, formatDate, formatDateTime, formatIn } from "@/lib/data/format";
import { useDemoShopUrl } from "@/lib/demo-shop";
import { DEMO_SHOP_SOON } from "@/lib/features";
import { useMerchant } from "@/lib/merchant-context";
import { useDashboardData, useQuery, useReadiness, type QueryState } from "@/lib/session";

/** This dashboard's origin: the `baseUrl` a merchant's server gives createPolarisServer. */
function useOrigin(): string {
  return useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );
}

export function DevelopersView() {
  const DEMO_SHOP_URL = useDemoShopUrl();
  return (
    <>
      <PageHead
        title="Developers"
        coins={[
          <PageCoin key="c" tone="blue">
            <CodeXml />
          </PageCoin>,
          <PolarisCoin key="p" size={50} />,
        ]}
        description="Take payments from your own site or app: create a checkout session on your server, send the buyer to it, and fulfil from a signed webhook. Everything is test mode: no real money moves."
        actions={
          <IconSquareButton
            label={DEMO_SHOP_URL ? "Open the demo shop (a new tab)" : DEMO_SHOP_SOON}
            icon={<Store />}
            disabled={!DEMO_SHOP_URL}
            onClick={() => DEMO_SHOP_URL && window.open(DEMO_SHOP_URL, "_blank", "noopener,noreferrer")}
          />
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-11 gap-y-4 xl:grid-cols-[minmax(0,1fr)_404px]">
        <div className="grid min-w-0 content-start gap-4">
          <ApiKeysPanel />
          <WebhooksPanel />
        </div>
        <div className="grid min-w-0 content-start gap-4 md:grid-cols-2 xl:grid-cols-1">
          <IntegrationPanel />
          <DemoShopPanel />
        </div>
        <Panel title="A few lines of code" subtitle="The whole integration, with polarispay-sdk 0.3.0" className="xl:col-span-2">
          <CodeBlock className="mt-5" aria-label="SDK example" note={sdk.note} copyable defaultKey="node" samples={sdk.samples.map((s) => ({ ...s }))} />
        </Panel>
      </div>
    </>
  );
}

/* ── The integration: who you are to the API ────────────────────────────── */

function IntegrationPanel() {
  const { merchant, capabilities } = useMerchant();
  const origin = useOrigin();
  const blocker = useReadiness().registration;
  const { run, busy, error } = useRegisterAction();
  const state = registrationOf(merchant);
  const canRegister = !blocker && (state === "none" || state === "failed");

  return (
    <Panel title="Your integration" subtitle="What your server needs, and where your business stands on Monad">
      <div className="mt-5 grid grid-cols-1 gap-3">
        <DetailsList
          size="sm"
          variant="surface"
          items={[
            {
              label: "Merchant ID",
              value: merchant.publicId ? (
                <span className="flex min-w-0 items-center justify-end gap-1.5">
                  <code className="min-w-0 truncate font-mono text-[13px]">{merchant.publicId}</code>
                  <CopyButton value={merchant.publicId} label="merchant ID" tone="ghost" />
                </span>
              ) : (
                "Assigned on first sign-in"
              ),
            },
            {
              label: "baseUrl",
              value: origin ? (
                <span className="flex min-w-0 items-center justify-end gap-1.5">
                  <code className="min-w-0 truncate font-mono text-[13px]">{origin}</code>
                  <CopyButton value={origin} label="API base URL" tone="ghost" />
                </span>
              ) : (
                "…"
              ),
            },
            { label: "Checkout", value: <code className="font-mono text-[13px]" title={capabilities?.checkoutOrigin ?? undefined}>{capabilities ? (capabilities.checkoutOrigin ?? "Not configured") : "…"}</code> },
          ]}
        />
        <div className="grid content-start gap-3">
          <DetailsList
            size="sm"
            variant="surface"
            items={[
              { label: "Network", value: capabilities?.chain ? `${capabilities.chain.name} (${capabilities.chain.id})` : "Not connected" },
              { label: "MerchantRegistry", value: <RegistrationBadge merchant={merchant} /> },
            ]}
          />
          {canRegister ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] bg-ui-surface-1 px-4 py-3">
              <p className="text-[13px] text-ui-muted">{error ?? "One confirmation with your payout account. Polaris pays the fee."}</p>
              <Button variant="lime" size="sm" loading={busy} onClick={() => void run()}>
                Register
              </Button>
            </div>
          ) : blocker && state === "none" ? (
            <p className="text-[13px] text-ui-muted">{blocker}</p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

const SHOP_POINTS = [
  "Pay now: paid in full in about a second",
  "Pay in 4: a $200 order is 4 × $50.38 for the buyer",
  "Straight from a wallet, gasless through the SDK relay",
  "Each order moves to Paid on its signed webhook",
];

function DemoShopPanel() {
  const DEMO_SHOP_URL = useDemoShopUrl();
  return (
    <PanelCard variant="filled" className="grid content-start gap-5">
      <span className="grid size-12 place-items-center rounded-full bg-ui-lime-button text-[#121418]">
        <ShoppingBag aria-hidden size={22} strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <h2 className="text-[18px] leading-tight font-medium tracking-[-0.015em]">See it in a shop</h2>
        <p className="mt-1 text-[14px] text-ui-muted">
          {DEMO_SHOP_URL ? (
            <>
              Halcyon, a demo store on polarispay-sdk, at <code className="font-mono text-[13px] text-ui-text">{DEMO_SHOP_URL}</code>
            </>
          ) : (
            "Halcyon, a demo store on polarispay-sdk. It opens here once it's deployed."
          )}
        </p>
        <ul className="mt-4 grid gap-y-2">
          {SHOP_POINTS.map((point) => (
            <li key={point} className="flex items-start gap-2.5 text-[14px]">
              <Check aria-hidden size={16} strokeWidth={2.25} className="mt-0.5 shrink-0 text-ui-lime-text" />
              {point}
            </li>
          ))}
        </ul>
      </div>
      <DemoShopButton label="Open the demo shop" variant="lime" size="md" className="w-full bg-ui-lime-button font-semibold text-[#121418]" />
    </PanelCard>
  );
}

/* ── A secret, shown once ───────────────────────────────────────────────── */

function RevealOnce({ title, secret, children }: { title: string; secret: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3">
      <p className="flex items-center gap-2 text-[15px] font-medium">
        <TriangleAlert aria-hidden size={17} strokeWidth={1.75} className="text-ui-pill-amber-text" />
        {title}
      </p>
      <p className="text-[14px] leading-relaxed text-ui-muted">{children}</p>
      <div className="flex min-w-0 items-center gap-2 rounded-ui-field bg-ui-surface-1 p-1.5 pl-4">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={secret}>
          {secret}
        </code>
        <CopyButton value={secret} label="secret" variant="button" buttonVariant="lime" />
      </div>
    </div>
  );
}

/* ── API keys ───────────────────────────────────────────────────────────── */

function ApiKeysPanel() {
  const keys = useQuery((d) => d.listApiKeys());
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const list = keys.data;

  return (
    <Panel
      title="API keys"
      subtitle="pk_test_… is safe in a browser. sk_test_… stays on your server; we show it once and keep only a hash."
      action={
        <PrimaryButton size="sm" icon={<Plus />} onClick={() => setCreating(true)} className="h-10">
          Create key
        </PrimaryButton>
      }
    >
      <StaleNotice queries={[keys as QueryState<unknown>]} />
      {keys.error && !list ? (
        <LoadError query={keys as QueryState<unknown>} title="We couldn't load your keys" />
      ) : !list ? (
        <Skeleton shape="row" height={72} className="mt-5" />
      ) : list.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<KeyRound />}
          title="No keys yet"
          description="Create one, then set it as POLARIS_SECRET_KEY on your server."
          action={
            <Button variant="lime" size="sm" icon={<Plus />} onClick={() => setCreating(true)}>
              Create key
            </Button>
          }
        />
      ) : (
        <ul className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-2">
          {list.map((k) => (
            <li
              key={k.id}
              className="grid gap-3 rounded-[20px] bg-ui-surface-1 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto_auto] md:items-center md:px-5 lg:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto_auto]"
            >
              <div className="min-w-0">
                <p className="flex min-w-0 items-center gap-2 text-[15px] font-medium">
                  <span className="truncate">{k.name}</span>
                </p>
                <p className="text-[13px] text-ui-muted">Created {formatDate(k.createdAt, true)}</p>
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 truncate font-mono text-[13px]" title={k.publishableKey}>
                  {k.publishableKey}
                </code>
                <CopyButton value={k.publishableKey} label="publishable key" tone="ghost" />
              </div>
              <div className="min-w-0 text-[13px]">
                <code className="font-mono">{k.secretHint}</code>
                <p className="text-ui-muted">{k.lastUsedAt ? `Used ${formatDate(k.lastUsedAt)}` : "Never used"}</p>
              </div>
              <SecondaryButton size="sm" icon={<Trash2 />} onClick={() => setRevoking(k)} className="h-10 justify-self-start bg-ui-surface-2 hover:bg-ui-surface-3">
                Revoke
              </SecondaryButton>
            </li>
          ))}
        </ul>
      )}

      <CreateKeyDialog open={creating} onOpenChange={setCreating} onCreated={(k) => keys.mutate((cur) => [k, ...(cur ?? [])])} />
      <RevokeDialog apiKey={revoking} onClose={() => setRevoking(null)} onDone={(id) => keys.mutate((cur) => cur?.filter((k) => k.id !== id))} />
    </Panel>
  );
}

function CreateKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (k: ApiKey) => void }) {
  const data = useDashboardData();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ value: string; name: string } | null>(null);

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setTimeout(() => {
        setSecret(null);
        setName("");
        setError(null);
      }, 250);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name it after where it will live, like “Production server”.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await data.createApiKey({ name: name.trim() });
      onCreated(created.key);
      setSecret({ value: created.secret, name: created.key.name });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={close} size="sm" title={secret ? "Copy your secret key" : "New API key"} dismissible={!busy}>
      {secret ? (
        <>
          <Dialog.Body>
            <RevealOnce title={`The secret key for “${secret.name}”`} secret={secret.value}>
              This is the only time it&rsquo;s shown. Set it as POLARIS_SECRET_KEY on your server. We store a hash of it, so if
              you lose it, revoke it and create another.
            </RevealOnce>
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="lime" onClick={() => close(false)}>
              I&rsquo;ve saved it
            </Button>
          </Dialog.Footer>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <Dialog.Body>
            <Input
              label="Name"
              placeholder="Production server"
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={error ?? undefined}
              autoFocus
            />
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="lime" loading={busy}>
              Create key
            </Button>
          </Dialog.Footer>
        </form>
      )}
    </Dialog>
  );
}

function RevokeDialog({ apiKey, onClose, onDone }: { apiKey: ApiKey | null; onClose: () => void; onDone: (id: string) => void }) {
  const data = useDashboardData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState(apiKey);
  if (apiKey && apiKey !== last) setLast(apiKey);
  const k = apiKey ?? last;
  const confirm = async () => {
    if (!k) return;
    setBusy(true);
    setError(null);
    try {
      await data.revokeApiKey(k.id);
      onDone(k.id);
      toast({ title: "Key revoked", description: `${k.name} stopped working.`, tone: "success" });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={apiKey !== null} onOpenChange={(o) => !o && onClose()} size="sm" title="Revoke this key?" description={k?.name}>
      <Dialog.Body className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <p className="text-[15px] leading-relaxed text-ui-muted">
          Anything still using {k?.secretHint} or its publishable key stops working at once. This can&rsquo;t be undone.
        </p>
        {error ? (
          <Notice tone="down" size="sm" role="alert">
            {error}
          </Notice>
        ) : null}
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" onClick={onClose}>
          Keep it
        </Button>
        <Button variant="white" className="bg-ui-down text-white hover:bg-ui-down/90" loading={busy} icon={<Trash2 />} onClick={confirm}>
          Revoke key
        </Button>
      </Dialog.Footer>
    </Dialog>
  );
}

/* ── Webhooks ───────────────────────────────────────────────────────────── */

/** What fed a delivery's event, for the log: the Envio indexer's outbox or this server's chain sync. */
const SOURCE_LABEL: Record<"chain" | "indexer", { short: string; long: string; tone: StatusPillTone }> = {
  indexer: { short: "Envio", long: "Envio indexer (Activity outbox)", tone: "teal" },
  chain: { short: "Chain sync", long: "Polaris chain sync", tone: "neutral" },
};

/** Where live events come from, when an indexer is configured. */
const FEED_NOTE: Record<"indexer" | "fallback", string> = {
  indexer: "Events come from the Envio indexer, with our chain sync as backup.",
  fallback: "The Envio indexer isn't answering: events come from our chain sync until it does.",
};

/** A delivery's result, in a word or two, with its tone. */
function deliveryResult(d: WebhookDelivery, now: number): { tone: StatusPillTone; text: string } {
  if (d.simulated) return { tone: "teal", text: "Signed, not sent" };
  if (d.state === "delivering") return { tone: "teal", text: "Sending" };
  if (d.state === "pending") {
    return { tone: "amber", text: d.nextAttemptAt ? `Retrying ${formatIn(d.nextAttemptAt, now)}` : "Queued" };
  }
  if (d.status && d.status < 300) return { tone: "lime", text: `HTTP ${d.status}` };
  if (d.state === "failed") return { tone: "red", text: d.status ? `Failed · HTTP ${d.status}` : "Failed" };
  return { tone: "red", text: d.status ? `HTTP ${d.status}` : "No response" };
}

function WebhooksPanel() {
  const data = useDashboardData();
  const hooks = useQuery((d) => d.listWebhooks(), { refreshMs: 30_000 });
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const [delivery, setDelivery] = useState<WebhookDelivery | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const now = useNow(30_000);
  const state = hooks.data;

  const upsertDelivery = (d: WebhookDelivery) =>
    hooks.mutate((s) => (s ? { ...s, deliveries: [d, ...s.deliveries.filter((x) => x.id !== d.id)] } : s));

  const sendTest = async (endpoint: WebhookEndpoint) => {
    setTesting(endpoint.id);
    try {
      const d = await data.sendTestEvent(endpoint.id);
      upsertDelivery(d);
      const ok = d.status !== null && d.status < 300;
      toast({
        title: ok ? `Test event delivered: HTTP ${d.status}` : "Test event sent, your endpoint didn't accept it",
        description: ok ? "It's in the delivery log with the exact request." : "Open it in the delivery log to see the request and the response.",
        tone: ok ? "success" : "info",
      });
    } catch (err) {
      toast({ title: "The test event didn't go through", description: errorMessage(err), tone: "error" });
    } finally {
      setTesting(null);
    }
  };

  return (
    <Panel
      title="Webhooks"
      subtitle="Every delivery is signed (Polaris-Signature: t=…, v1=…) with the endpoint's own secret"
      action={
        <PrimaryButton size="sm" icon={<Plus />} onClick={() => setAdding(true)} className="h-10">
          Add endpoint
        </PrimaryButton>
      }
    >
      <StaleNotice queries={[hooks as QueryState<unknown>]} />
      {hooks.error && !state ? (
        <LoadError query={hooks as QueryState<unknown>} title="We couldn't load your webhooks" />
      ) : !state ? (
        <Skeleton shape="row" height={72} className="mt-5" />
      ) : state.endpoints.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<Webhook />}
          title="No endpoints yet"
          description="Add your server's HTTPS URL to hear about payments, plans and payouts."
          action={
            <Button variant="lime" size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
              Add endpoint
            </Button>
          }
        />
      ) : (
        <ul className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-2">
          {state.endpoints.map((e) => (
            <li key={e.id} className="flex flex-col gap-3 rounded-[20px] bg-ui-surface-1 p-4 md:flex-row md:items-center md:px-5">
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-2">
                  <code className="truncate font-mono text-[14px]">{e.url}</code>
                </p>
                <p className="mt-1 text-[13px] text-ui-muted">
                  {e.events.length} {e.events.length === 1 ? "event" : "events"} · secret {e.secretHint} · added {formatDate(e.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <SecondaryButton size="sm" className="h-10 bg-ui-surface-2 hover:bg-ui-surface-3" icon={<Send />} loading={testing === e.id} onClick={() => void sendTest(e)}>
                  Send test event
                </SecondaryButton>
                <Menu
                  label={`More for ${e.url}`}
                  align="end"
                  width={220}
                  trigger={
                    <span className="grid size-10 place-items-center rounded-[12px] border border-ui-hairline-strong bg-ui-square text-[#a7a9ad] transition-colors hover:text-ui-text">
                      <MoreHorizontal aria-hidden size={18} strokeWidth={1.75} />
                    </span>
                  }
                >
                  <Menu.Item icon={<Trash2 />} tone="danger" onSelect={() => setDeleting(e)}>
                    Remove endpoint
                  </Menu.Item>
                </Menu>
              </div>
            </li>
          ))}
        </ul>
      )}

      {state && state.deliveries.length ? (
        <div className="mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[16px] font-medium">Delivery log</h3>
            <p className="text-[13px] text-ui-muted">Failed deliveries retry up to 8 times over about 34 hours.</p>
          </div>
          {state.feed && state.feed.mode !== "chain-sync" ? (
            <p className={`mt-1 text-[13px] ${state.feed.mode === "fallback" ? "text-ui-warn" : "text-ui-muted"}`}>{FEED_NOTE[state.feed.mode]}</p>
          ) : null}
          <ul className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-1.5">
            {state.deliveries.slice(0, 12).map((d) => {
              const r = deliveryResult(d, now);
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setDelivery(d)}
                    className="flex w-full items-center gap-3 rounded-[20px] bg-ui-surface-1 px-4 py-3 text-left transition-colors hover:bg-ui-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus"
                  >
                    <StatusPill tone={r.tone} size="sm" className="hidden shrink-0 sm:inline-flex">
                      {r.text}
                    </StatusPill>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-[13px]">{d.event}</span>
                        {d.test ? (
                          <StatusPill tone="neutral" size="sm" className="h-6 px-2.5 text-[12px]">
                            Test
                          </StatusPill>
                        ) : d.source === "indexer" || d.source === "chain" ? (
                          <StatusPill tone={SOURCE_LABEL[d.source].tone} size="sm" className="h-6 shrink-0 px-2.5 text-[12px]">
                            {SOURCE_LABEL[d.source].short}
                          </StatusPill>
                        ) : null}
                      </span>
                      <span className="block truncate text-[12px] text-ui-muted">{d.url}</span>
                      <span className="mt-1.5 flex items-center gap-2 sm:hidden">
                        <StatusPill tone={r.tone} size="sm">
                          {r.text}
                        </StatusPill>
                        <span className="text-[12px] text-ui-muted">{formatAgo(d.createdAt, now)}</span>
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-[12px] text-ui-muted sm:block">
                      {(d.attempts?.length ?? d.attempt) > 1 ? `${d.attempts?.length ?? d.attempt} attempts · ` : ""}
                      {formatAgo(d.createdAt, now)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <AddEndpointDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={(endpoint) => hooks.mutate((s) => (s ? { ...s, endpoints: [...s.endpoints, endpoint] } : s))}
      />
      <DeleteEndpointDialog
        endpoint={deleting}
        onClose={() => setDeleting(null)}
        onDone={(id) => hooks.mutate((s) => (s ? { ...s, endpoints: s.endpoints.filter((x) => x.id !== id) } : s))}
      />
      <DeliveryDrawer
        delivery={delivery}
        onClose={() => setDelivery(null)}
        onRetried={(d) => {
          upsertDelivery(d);
          setDelivery(d);
        }}
      />
    </Panel>
  );
}

function AddEndpointDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (e: WebhookEndpoint) => void }) {
  const data = useDashboardData();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>(["payment.succeeded", "plan.opened"]);
  const [errors, setErrors] = useState<{ url?: string; events?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const close = () => {
    onClose();
    setTimeout(() => {
      setUrl("");
      setEvents(["payment.succeeded", "plan.opened"]);
      setErrors({});
      setSecret(null);
    }, 250);
  };
  const toggle = (ev: WebhookEventType) => setEvents((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!/^https?:\/\/\S+$/i.test(url.trim())) next.url = "Enter your endpoint's full URL, starting with https://.";
    if (!events.length) next.events = "Choose at least one event.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const created = await data.createWebhook({ url: url.trim(), events });
      onSaved(created.endpoint);
      setSecret(created.secret);
    } catch (err) {
      const field = err instanceof DataError ? err.field : undefined;
      setErrors(field === "url" ? { url: errorMessage(err) } : field === "events" ? { events: errorMessage(err) } : { form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={secret ? "Copy the signing secret" : "Add a webhook endpoint"}
      description={secret ? undefined : "We sign every delivery; verify it with polarispay-sdk's webhooks.verify."}
      dismissible={!busy}
    >
      {secret ? (
        <>
          <Dialog.Body>
            <RevealOnce title="Your endpoint's signing secret" secret={secret}>
              Shown once. Set it as POLARIS_WEBHOOK_SECRET where you verify deliveries.
            </RevealOnce>
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="lime" onClick={close}>
              I&rsquo;ve saved it
            </Button>
          </Dialog.Footer>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <Dialog.Body className="grid grid-cols-[minmax(0,1fr)] gap-5">
            <Input
              label="Endpoint URL"
              placeholder="https://your.shop/api/polaris/webhook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              error={errors.url}
              className="font-mono text-[14px]"
              spellCheck={false}
              hint="Public HTTPS. Private and internal addresses are refused, when you add it and again at every delivery."
            />
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-[14px] font-medium text-ui-muted">Events</legend>
              <div className="flex flex-wrap gap-2">
                {WEBHOOK_EVENTS.map((ev) => (
                  <Chip key={ev} size="sm" variant="pill" selected={events.includes(ev)} onClick={() => toggle(ev)} className="font-mono text-[12px]">
                    {ev}
                  </Chip>
                ))}
              </div>
              {errors.events ? (
                <p role="alert" className="text-[13px] text-ui-down">
                  {errors.events}
                </p>
              ) : null}
            </fieldset>
            {errors.form ? (
              <Notice tone="down" size="sm" role="alert">
                {errors.form}
              </Notice>
            ) : null}
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="lime" loading={busy}>
              Add endpoint
            </Button>
          </Dialog.Footer>
        </form>
      )}
    </Dialog>
  );
}

function DeleteEndpointDialog({ endpoint, onClose, onDone }: { endpoint: WebhookEndpoint | null; onClose: () => void; onDone: (id: string) => void }) {
  const data = useDashboardData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState(endpoint);
  if (endpoint && endpoint !== last) setLast(endpoint);
  const e = endpoint ?? last;
  const confirm = async () => {
    if (!e) return;
    setBusy(true);
    setError(null);
    try {
      await data.deleteWebhook(e.id);
      onDone(e.id);
      toast({ title: "Endpoint removed", tone: "success" });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={endpoint !== null} onOpenChange={(o) => !o && onClose()} size="sm" title="Remove this endpoint?" description={e?.url}>
      <Dialog.Body className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <p className="text-[15px] leading-relaxed text-ui-muted">
          Nothing more is sent to it, and deliveries still waiting for a retry are dropped. Its past deliveries stay in the log.
        </p>
        {error ? (
          <Notice tone="down" size="sm" role="alert">
            {error}
          </Notice>
        ) : null}
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" onClick={onClose}>
          Keep it
        </Button>
        <Button variant="white" className="bg-ui-down text-white hover:bg-ui-down/90" loading={busy} icon={<Trash2 />} onClick={confirm}>
          Remove endpoint
        </Button>
      </Dialog.Footer>
    </Dialog>
  );
}

function DeliveryDrawer({
  delivery,
  onClose,
  onRetried,
}: {
  delivery: WebhookDelivery | null;
  onClose: () => void;
  onRetried: (d: WebhookDelivery) => void;
}) {
  const data = useDashboardData();
  const now = useNow(30_000);
  const [retrying, setRetrying] = useState(false);
  const [last, setLast] = useState(delivery);
  if (delivery && delivery !== last) setLast(delivery);
  const d = delivery ?? last;
  let body = d?.request.body ?? "";
  try {
    body = JSON.stringify(JSON.parse(body), null, 2);
  } catch {}
  const result = d ? deliveryResult(d, now) : null;
  const canRetry = d !== null && !d.simulated && d.state !== "delivering" && !(d.status !== null && d.status < 300 && d.state === "succeeded");

  const retry = async () => {
    if (!d) return;
    setRetrying(true);
    try {
      const next = await data.retryDelivery(d.id);
      onRetried(next);
      const ok = next.status !== null && next.status < 300;
      toast({ title: ok ? `Delivered: HTTP ${next.status}` : "Sent again; your endpoint still didn't accept it", tone: ok ? "success" : "info" });
    } catch (err) {
      toast({ title: "We couldn't retry it", description: errorMessage(err), tone: "error" });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Drawer open={delivery !== null} onOpenChange={(o) => !o && onClose()} size="lg" title="Delivery" description={d?.id}>
      {d && result ? (
        <>
          <Drawer.Body className="grid grid-cols-[minmax(0,1fr)] content-start gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={result.tone}>{result.text}</StatusPill>
              {d.test ? <StatusPill tone="neutral">Test event</StatusPill> : null}
            </div>
            <DetailsList
              size="sm"
              variant="surface"
              items={[
                { label: "Event", value: <code className="font-mono text-[13px]">{d.event}</code> },
                { label: "Event ID", value: <code className="font-mono text-[13px]">{d.eventId}</code> },
                ...(d.source === "indexer" || d.source === "chain" ? [{ label: "Source", value: SOURCE_LABEL[d.source].long }] : []),
                { label: "Endpoint", value: <span className="font-mono text-[13px] break-all">{d.url}</span> },
                { label: "Created", value: formatDateTime(d.createdAt) },
                ...(d.state === "pending" && d.nextAttemptAt ? [{ label: "Next attempt", value: formatDateTime(d.nextAttemptAt) }] : []),
              ]}
            />
            {d.attempts && d.attempts.length ? (
              <div>
                <h3 className="mb-2 text-[15px] font-medium">Attempts</h3>
                <ol className="grid gap-1.5">
                  {d.attempts.map((a, i) => (
                    <li key={`${a.at}-${i}`} className="flex items-center gap-3 rounded-[20px] bg-ui-surface-1 px-4 py-2.5 text-[13px]">
                      <span className="w-6 text-ui-muted">{i + 1}</span>
                      <StatusPill tone={a.status && a.status < 300 ? "lime" : "red"} size="sm">
                        {a.status ? `HTTP ${a.status}` : "No response"}
                      </StatusPill>
                      <span className="min-w-0 flex-1 truncate text-ui-muted">{a.error ?? `${a.durationMs} ms`}</span>
                      <span className="shrink-0 text-ui-muted">{formatAgo(a.at, now)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <CodeBlock
              copyable
              showLineNumbers={false}
              samples={[
                {
                  key: "headers",
                  label: "Headers",
                  code: Object.entries(d.request.headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n"),
                },
                { key: "body", label: "Body", code: body, language: "json" },
              ]}
            />
          </Drawer.Body>
          {canRetry ? (
            <Drawer.Footer>
              <Button variant="lime" icon={<RotateCcw />} loading={retrying} onClick={() => void retry()}>
                Retry now
              </Button>
            </Drawer.Footer>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}

"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { CloseIcon } from "@/components/icons";
import { fetchOrder } from "@/lib/checkout-client";
import type { Order } from "@/lib/orders/types";
import { PolarisMark } from "@/lib/polaris-client";
import { useShop } from "@/lib/shop-context";

type Entry =
  | { kind: "call"; at: string; side: "server" | "browser"; call: string; args?: unknown; result?: unknown; error?: string }
  | { kind: "event"; at: string; type: string; id: string; summary: string; outcome: string };

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

const CODE_SERVER = `// app/api/checkout/route.ts
import { createPolarisServer } from "polarispay-sdk/server";

const polaris = createPolarisServer({
  secretKey: process.env.POLARIS_SECRET_KEY,
  baseUrl: process.env.POLARIS_API_BASE,
});

const session = await polaris.checkout.sessions.create(
  {
    amount: "349.00",
    description: "Halcyon order",
    lineItems,
    modes: ["later", "now"],
    successUrl: \`\${origin}/orders/\${order.id}\`,
    orderId: order.id,
  },
  { idempotencyKey: order.id },
);`;

const CODE_BROWSER = `// the checkout page
import { createPolaris } from "polarispay-sdk";

const polaris = createPolaris({ publishableKey, relayUrl });

// a popup on desktop, a redirect on phones
const result = await polaris.openCheckout(createSession);

// or pay straight from a wallet, gas-free
await polaris.pay({ merchant, amount, orderId });`;

const CODE_WEBHOOK = `// app/api/webhooks/polaris/route.ts
const event = polaris.webhooks.verify(
  await req.text(),
  req.headers.get("polaris-signature"),
  process.env.POLARIS_WEBHOOK_SECRET,
);
// Delivery is at least once.
if (await seen(event.id)) return ok();

const order = await byPayRef(event.data.orderId);
if (event.type === "payment.succeeded") {
  const { amount, currency } = event.data;
  if (cents(amount) !== order.total ||
      currency !== "USD") {
    return flagForReview(order);
  }
  await markPaid(order);
}`;

function Json({ value }: { value: unknown }) {
  return (
    <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[0.74rem] leading-relaxed text-[#d6e5c4]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

const TOKEN = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|from|const|await|async|if|return|export|function|new)\b/g;

/** A few colours for the samples: comments, strings, keywords. No dependency needed for ten lines. */
function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    if (m.index! > last) out.push(code.slice(last, m.index));
    const [text, comment, string] = m;
    const tone = comment ? "text-white/45" : string ? "text-[#d9fca0]" : "text-[#c4b5fd]";
    out.push(
      <span key={m.index} className={tone}>
        {text}
      </span>,
    );
    last = m.index! + text.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked: the code is still there to select.
    }
  };
  return (
    <div className="relative">
      <pre className="whitespace-pre-wrap break-words rounded-xl bg-black/40 p-3.5 pr-16 font-mono text-[0.7rem] leading-[1.65] text-[#e9ecef] sm:whitespace-pre sm:p-4 sm:pr-16 sm:text-[0.76rem]">
        <code>{highlight(children)}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 h-8 rounded-full bg-white/[0.08] px-3 text-[0.74rem] text-white/75 hover:bg-white/[0.14] hover:text-white"
        aria-label={copied ? "Copied" : "Copy this code"}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function DevDrawer() {
  const { currentOrderId, drawerOpen, menuOpen, buyBar } = useShop();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"order" | "code">("order");
  const [order, setOrder] = useState<Order | null>(null);
  const reduce = useReducedMotion();
  const buttonRef = useRef<HTMLButtonElement>(null);
  // On a phone the round button would sit on whatever scrolls under it (a product title, the
  // checkout's copy): it steps aside while the page moves and comes back when it stops.
  const [scrolling, setScrolling] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const onScroll = () => {
      if (window.innerWidth >= 640) return;
      setScrolling(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setScrolling(false), 900);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, []);

  const orderId = pathname.startsWith("/orders/") ? pathname.split("/")[2] ?? currentOrderId : currentOrderId;

  const load = useCallback(async () => {
    if (!orderId) return;
    const latest = await fetchOrder(orderId);
    if (latest) setOrder(latest.order);
  }, [orderId]);

  useEffect(() => {
    if (!open) return;
    const first = window.setTimeout(load, 0);
    const t = window.setInterval(load, 2000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, load]);

  // Out of the way of the store's own overlays: the bag and the phone menu.
  if (pathname.startsWith("/api/") || drawerOpen || menuOpen) return null;

  const entries: Entry[] = order
    ? [
        ...order.sdkLog.map((c) => ({ kind: "call" as const, ...c })),
        ...order.events.map((e) => ({ kind: "event" as const, at: e.receivedAt, type: e.type, id: e.id, summary: e.summary, outcome: e.outcome })),
      ].sort((a, b) => a.at.localeCompare(b.at))
    : [];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="dev-drawer"
        aria-label="Built with Polaris"
        className={`fixed right-3 z-30 inline-flex h-10 w-10 items-center justify-center gap-2 rounded-full bg-[#151514] text-[0.82rem] font-medium text-[#f5f5f5] shadow-[0_10px_30px_-10px_rgb(0_0_0/0.5)] transition-[transform,bottom,opacity] hover:scale-[1.03] sm:bottom-6 sm:right-6 sm:w-auto sm:pl-3 sm:pr-4 ${
          buyBar ? "bottom-[5.5rem]" : "bottom-3"
        } ${scrolling && !open ? "pointer-events-none translate-x-16 opacity-0" : ""}`}
      >
        <PolarisMark className="!block !h-4 !w-4 ![filter:none]" />
        <span className="hidden sm:inline">Built with Polaris</span>
        {order && order.events.length > 0 ? (
          <span className="num absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-[#bffa62] px-1 text-[0.7rem] text-[#151514] sm:static">
            {order.events.length}
          </span>
        ) : null}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.aside
            id="dev-drawer"
            aria-label="Built with Polaris: the SDK calls behind this checkout"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-2 bottom-2 z-40 flex max-h-[82dvh] flex-col overflow-hidden rounded-2xl bg-[#151514] text-[#f5f5f5] shadow-[0_30px_80px_-20px_rgb(0_0_0/0.6)] sm:inset-x-auto sm:bottom-20 sm:right-6 sm:w-[520px] sm:max-h-[min(78dvh,760px)]"
          >
            <div className="flex items-center justify-between px-5 pt-4">
              <p className="flex items-center gap-2 text-[0.95rem] font-semibold">
                <PolarisMark className="!block !h-[18px] !w-[16px] ![filter:none]" /> Built with Polaris
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/10"
                aria-label="Close developer drawer"
              >
                <CloseIcon size={18} />
              </button>
            </div>
            <div role="tablist" aria-label="View" className="mx-5 mt-3 grid grid-cols-2 rounded-full bg-white/[0.06] p-1 text-[0.84rem]">
              {(["order", "code"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`h-8 rounded-full transition-colors ${tab === t ? "bg-white/[0.14] text-white" : "text-white/60 hover:text-white"}`}
                >
                  {t === "order" ? "This checkout" : "The code"}
                </button>
              ))}
            </div>

            <div className="mt-4 flex-1 overflow-y-auto px-5 pb-5">
              {tab === "code" ? (
                <div className="space-y-4">
                  <p className="text-[0.86rem] leading-relaxed text-white/65">
                    The whole integration: a session on the server, the checkout in the browser, and a verified webhook that marks the order paid.
                  </p>
                  <Code>{CODE_SERVER}</Code>
                  <Code>{CODE_BROWSER}</Code>
                  <Code>{CODE_WEBHOOK}</Code>
                </div>
              ) : !order ? (
                <p className="py-10 text-center text-[0.9rem] text-white/60">Place an order to see the SDK calls it makes and the webhooks it receives.</p>
              ) : (
                <>
                  <div className="flex items-center justify-between text-[0.8rem] text-white/55">
                    <span className="num">
                      Order {order.number} · <span className={order.status === "paid" ? "text-[#bffa62]" : ""}>{order.status.replace("_", " ")}</span>
                    </span>
                  </div>
                  <ol className="mt-3 space-y-2.5">
                    {entries.map((entry, i) => (
                      <li key={`${entry.at}-${i}`} className="rounded-xl bg-white/[0.05] p-3">
                        {entry.kind === "call" ? (
                          <details>
                            <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                              <span
                                className={`rounded-md px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide ${
                                  entry.side === "server" ? "bg-sky-300/15 text-sky-200" : "bg-violet-300/15 text-violet-200"
                                }`}
                              >
                                {entry.side}
                              </span>
                              <code className="min-w-0 flex-1 truncate font-mono text-[0.8rem]">{entry.call}()</code>
                              <span className="num text-[0.72rem] text-white/45">{TIME.format(new Date(entry.at))}</span>
                            </summary>
                            {entry.args !== undefined ? <Json value={entry.args} /> : null}
                            {entry.result !== undefined ? (
                              <>
                                <p className="mt-2 text-[0.72rem] uppercase tracking-wide text-white/45">Returned</p>
                                <Json value={entry.result} />
                              </>
                            ) : null}
                            {entry.error ? <p className="mt-2 text-[0.8rem] text-rose-300">{entry.error}</p> : null}
                          </details>
                        ) : (
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="rounded-md bg-[#bffa62]/15 px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide text-[#d9fca0]">webhook</span>
                              <code className="min-w-0 flex-1 truncate font-mono text-[0.8rem]">{entry.type}</code>
                              <span className="num text-[0.72rem] text-white/45">{TIME.format(new Date(entry.at))}</span>
                            </div>
                            <p className="mt-1.5 text-[0.8rem] text-white/70">
                              Signature verified · {entry.summary}
                              {entry.outcome === "flagged" ? " · flagged for review" : ""}
                            </p>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </>
  );
}

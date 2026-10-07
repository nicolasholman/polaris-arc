import { canRead, tokenFromRequest } from "@/lib/orders/access";
import { appendBrowserLog, getOrder } from "@/lib/orders/service";
import type { SdkCall } from "@/lib/orders/types";

export const dynamic = "force-dynamic";

const BROWSER_CALLS = new Set(["createPolaris", "polaris.openCheckout", "polaris.redirectToCheckout", "polaris.pay"]);

/**
 * The browser reports the SDK calls it made (openCheckout, pay) so the
 * "Built with Polaris" drawer shows both halves of the integration. This only
 * appends to a log, and only for the browser that placed the order, while
 * it's unpaid or for a few minutes after it's paid, up to a handful of
 * entries; nothing here can touch an order's status.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) return Response.json({ error: { message: "No such order." } }, { status: 404 });
  if (!canRead(order, tokenFromRequest(req, id))) return Response.json({ error: { message: "Not your order." } }, { status: 403 });
  const text = await req.text();
  if (text.length > 16_000) return Response.json({ error: { message: "Too large." } }, { status: 413 });
  let entries: unknown;
  try {
    entries = JSON.parse(text);
  } catch {
    return Response.json({ error: { message: "Not JSON." } }, { status: 400 });
  }
  if (!Array.isArray(entries) || entries.length > 10) {
    return Response.json({ error: { message: "Send up to 10 entries." } }, { status: 400 });
  }
  const clean: SdkCall[] = [];
  for (const raw of entries as Record<string, unknown>[]) {
    if (!raw || typeof raw.call !== "string" || !BROWSER_CALLS.has(raw.call)) continue;
    clean.push({
      at: typeof raw.at === "string" ? raw.at : new Date().toISOString(),
      side: "browser",
      call: raw.call,
      args: raw.args,
      result: raw.result,
      error: typeof raw.error === "string" ? raw.error.slice(0, 300) : undefined,
    });
  }
  const result = await appendBrowserLog(id, clean);
  if (!result.ok) return Response.json({ error: { message: "This order's log is closed." } }, { status: 409 });
  return Response.json({ ok: true, recorded: result.recorded });
}

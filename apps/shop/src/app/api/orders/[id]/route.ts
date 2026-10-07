import { canRead, orderForBrowser, tokenFromRequest } from "@/lib/orders/access";
import { claimSync, getOrder, logRetrieve } from "@/lib/orders/service";
import { retrieveCheckoutSession } from "@/lib/polaris";

export const dynamic = "force-dynamic";

/**
 * The order, for the receipt page to poll.
 *
 * With the order's access cookie (set when this browser placed it) it comes
 * back whole; without it, the buyer's name, email and address are masked.
 *
 * `?sync=1` also asks Polaris for the session (sessions.retrieve) to show
 * whether the buyer finished. Only the browser that placed the order may ask,
 * only while it's unpaid, and at most once every 10 seconds; the answer is
 * logged only when it changes. The order itself still only changes on a
 * verified webhook.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let order = await getOrder(id);
  if (!order) return Response.json({ error: { code: "not_found", message: "No such order." } }, { status: 404 });
  const readable = canRead(order, tokenFromRequest(req, id));

  let session: { status: string; mode: string | null } | null = null;
  if (readable && new URL(req.url).searchParams.get("sync") === "1" && order.payment.sessionId && (await claimSync(id))) {
    try {
      const retrieved = await retrieveCheckoutSession(order.payment.sessionId);
      session = { status: retrieved.session.status, mode: retrieved.session.payment?.mode ?? null };
      order = (await logRetrieve(order.id, retrieved.log)) ?? order;
    } catch {
      session = null;
    }
  }
  return Response.json({ order: orderForBrowser(order, readable), session }, { headers: { "cache-control": "no-store" } });
}

import { centsToDecimal } from "@/lib/money";
import { accessCookie, payRefOf, tokenFromRequest } from "@/lib/orders/access";
import { parseCheckoutRequest } from "@/lib/orders/checkout-request";
import { appendSdkLog, attachSession, createOrder, nextSessionAttempt, reusableSession } from "@/lib/orders/service";
import type { Order, SdkCall } from "@/lib/orders/types";
import { requestOrigin } from "@/lib/origin";
import { createCheckoutSession, polarisConfig } from "@/lib/polaris";

export const dynamic = "force-dynamic";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:\-]{8,100}$/;

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

function summary(order: Order) {
  return { id: order.id, number: order.number, status: order.status, total: order.total };
}

/**
 * Place an order and start paying for it.
 *
 * - Polaris: create a checkout session with the SDK and return its URL, which
 *   the browser opens with openCheckout().
 * - Wallet: return the merchant, amount and order id the browser signs with
 *   pay().
 *
 * The order stays "awaiting_payment" until a verified webhook says otherwise.
 * Send an Idempotency-Key: a retried or double-clicked request gets the same
 * order and session back instead of a second one. Send `continueOrder` (the
 * order this browser was already paying) when the buyer changes how they
 * pay: an unpaid order for the same goods is reused, never doubled.
 *
 * The response sets an HttpOnly cookie that lets this browser read the order
 * back (the receipt, the developer drawer). Polaris and pay() get the order's
 * payRef, never its id.
 */
export async function POST(req: Request) {
  const origin = requestOrigin(req);
  const config = polarisConfig();
  if (!config.ok) {
    // No Polaris settings, no payment: nothing is created and nothing pretends to succeed.
    return error(
      503,
      "payments_not_configured",
      "Payments aren't configured on this store.",
      process.env.NODE_ENV === "development" ? { detail: config.reason } : {},
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, "invalid_json", "The request wasn't JSON.");
  }
  const parsed = parseCheckoutRequest(body);
  if (!parsed.ok) return error(422, "invalid_checkout", "Some details need another look.", { fields: parsed.errors });

  const key = req.headers.get("idempotency-key");
  if (key !== null && !IDEMPOTENCY_KEY.test(key)) {
    return error(400, "invalid_idempotency_key", "Idempotency-Key must be 8 to 100 letters, digits, _, - or :.");
  }

  const continueId = (body as { continueOrder?: unknown }).continueOrder;
  const continueOrder = typeof continueId === "string" && /^hc_[a-z2-7]{20}$/.test(continueId) ? { id: continueId, token: tokenFromRequest(req, continueId) } : null;

  const created = await createOrder(parsed.value, key, undefined, undefined, continueOrder);
  if (!created.ok) return error(409, "idempotency_conflict", "This checkout changed after it was sent. Please try again.");
  let order: Order = created.order;
  const cookie = accessCookie(order, origin);
  const init: ResponseInit = cookie ? { headers: { "set-cookie": cookie } } : {};

  if (order.status !== "awaiting_payment" || order.payment.method === "wallet") {
    return Response.json(
      {
        order: summary(order),
        reused: created.reused,
        ...(order.payment.method === "wallet" && order.status === "awaiting_payment"
          ? { wallet: { merchant: config.merchant, amount: centsToDecimal(order.total), orderId: payRefOf(order) } }
          : {}),
      },
      init,
    );
  }

  const open = reusableSession(order);
  if (open) {
    return Response.json({ order: summary(order), reused: true, checkout: { sessionId: open.id, url: open.url } }, init);
  }

  if (order.payment.sessionId) order = (await nextSessionAttempt(order.id)) ?? order;
  try {
    const { session, log } = await createCheckoutSession(order, origin);
    await attachSession(order.id, session, log);
    return Response.json({ order: summary(order), reused: created.reused, checkout: { sessionId: session.id, url: session.url } }, init);
  } catch (e) {
    const log = (e as { sdkLog?: SdkCall }).sdkLog;
    if (log) await appendSdkLog(order.id, [log]);
    console.error("[checkout] Couldn't create a Polaris session", e);
    return error(502, "polaris_unavailable", "We couldn't reach Polaris just now. Try again, or pay directly with a wallet.");
  }
}

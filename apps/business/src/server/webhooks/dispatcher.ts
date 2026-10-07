import "server-only";

import {
  deliverWebhook,
  MAX_DELIVERY_ATTEMPTS,
  nextAttemptAt,
  type DeliveryAttempt,
  type Transport,
  type WebhookDeliveryRecord,
} from "@polaris/db";

import { afterResponse } from "../background";
import { getDb } from "../db";
import { getConfig } from "../env";

/**
 * Send what's due: new deliveries at once, failed ones on the retry schedule
 * (1 min, 5 min, 30 min, 2 h, 6 h, 10 h, 15 h: eight attempts over about 34
 * hours). Each delivery is claimed with a short lock before it is sent, so
 * two dispatchers (the in-process loop and the cron route) never send the
 * same attempt twice; a lock left by a crash expires and the attempt runs
 * again, which at-least-once delivery allows.
 */

const LOCK_MS = 60_000;
const BATCH = 25;
const CONCURRENCY = 5;
/** How many of one endpoint's deliveries a pass sends, one after another. */
const PER_ENDPOINT_PER_PASS = 10;

let transportOverride: Transport | undefined;
let autoKick = true;

/** Tests: replace the network, and stop background kicks. */
export function configureDispatcherForTests(options: { transport?: Transport; autoKick?: boolean }): void {
  transportOverride = options.transport;
  if (options.autoKick !== undefined) autoKick = options.autoKick;
}

export type DispatchSummary = { attempted: number; succeeded: number; retrying: number; failed: number };

/** Claim a delivery for this dispatcher, or null when someone else holds it. */
async function claim(id: string, nowMs: number): Promise<WebhookDeliveryRecord | null> {
  const token = nowMs + LOCK_MS + Math.floor(Math.random() * 1000);
  const claimed = await getDb().webhookDeliveries.update(id, (d) => {
    const due = d.nextAttemptAtMs !== null && d.nextAttemptAtMs <= nowMs;
    const free = d.state === "pending" || (d.state === "delivering" && d.lockedUntilMs <= nowMs);
    return due && free ? { ...d, state: "delivering", lockedUntilMs: token } : d;
  });
  return claimed && claimed.state === "delivering" && claimed.lockedUntilMs === token ? claimed : null;
}

async function attempt(delivery: WebhookDeliveryRecord, nowMs: number): Promise<"succeeded" | "retrying" | "failed"> {
  const db = getDb();
  const { webhooks } = getConfig();
  const [endpoint, event] = await Promise.all([db.webhookEndpoints.get(delivery.endpointId), db.webhookEvents.get(delivery.eventId)]);
  const at = new Date(nowMs).toISOString();

  if (!endpoint || endpoint.disabledAt || !event) {
    await db.webhookDeliveries.update(delivery.id, (d) => ({
      ...d,
      state: "failed",
      nextAttemptAtMs: null,
      lockedUntilMs: 0,
      attempts: [...d.attempts, { at, status: null, durationMs: 0, error: "The endpoint was removed.", responseBody: null }],
      updatedAt: at,
    }));
    return "failed";
  }

  const outcome = await deliverWebhook({
    url: endpoint.url,
    secret: endpoint.secret,
    eventType: delivery.type,
    body: event.body,
    attempt: delivery.attempts.length + 1,
    allowPrivate: webhooks.allowPrivate,
    timeoutMs: webhooks.timeoutMs,
    nowSeconds: Math.floor(nowMs / 1000),
    transport: transportOverride,
  });

  const record: DeliveryAttempt = {
    at,
    status: outcome.status,
    durationMs: outcome.durationMs,
    error: outcome.error,
    responseBody: outcome.responseBody,
  };
  const made = delivery.attempts.length + 1;
  const next = outcome.ok || !outcome.retryable ? null : nextAttemptAt(made, Date.now());
  const state = outcome.ok ? "succeeded" : next === null ? "failed" : "pending";
  await db.webhookDeliveries.update(delivery.id, (d) => ({
    ...d,
    state,
    nextAttemptAtMs: next,
    lockedUntilMs: 0,
    attempts: [...d.attempts, record],
    request: outcome.request,
    updatedAt: new Date().toISOString(),
  }));
  return state === "pending" ? "retrying" : state;
}

/** Deliver everything due now (or just `ids`). */
export async function dispatchDue(options: { nowMs?: number; limit?: number; ids?: string[] } = {}): Promise<DispatchSummary> {
  const db = getDb();
  const nowMs = options.nowMs ?? Date.now();
  const summary: DispatchSummary = { attempted: 0, succeeded: 0, retrying: 0, failed: 0 };

  const due = options.ids
    ? (await Promise.all(options.ids.map((id) => db.webhookDeliveries.get(id)))).filter((d): d is WebhookDeliveryRecord => d !== null)
    : [
        ...(await db.webhookDeliveries.find({ state: "pending", nextAttemptAtMs: { lte: nowMs } }, { orderBy: "nextAttemptAtMs", limit: options.limit ?? BATCH })),
        // A dispatcher that died mid-send left its lock; take those over once it expires.
        ...(await db.webhookDeliveries.find({ state: "delivering", nextAttemptAtMs: { lte: nowMs } }, { limit: 10 })).filter(
          (d) => d.lockedUntilMs <= nowMs,
        ),
      ];

  // One worker serves one endpoint at a time, so a slow or hostile endpoint ties up at most one worker (for at
  // most its attempts' timeouts) while the others deliver everyone else's. An endpoint that fails an attempt gets
  // no more this pass: the rest of its deliveries wait for the next one.
  const byEndpoint = new Map<string, WebhookDeliveryRecord[]>();
  for (const d of due) {
    const list = byEndpoint.get(d.endpointId) ?? [];
    list.push(d);
    byEndpoint.set(d.endpointId, list);
  }
  const endpoints = [...byEndpoint.values()];
  const workers = Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, async () => {
    for (let list = endpoints.shift(); list; list = endpoints.shift()) {
      let sent = 0;
      for (const next of list) {
        if (sent >= PER_ENDPOINT_PER_PASS) break;
        const claimed = await claim(next.id, nowMs);
        if (!claimed) continue;
        sent++;
        summary.attempted++;
        const result = await attempt(claimed, nowMs);
        summary[result]++;
        if (result !== "succeeded") break;
      }
    }
  });
  await Promise.all(workers);
  return summary;
}

let running: Promise<unknown> | null = null;
let again = false;

/**
 * Run the dispatcher soon, without holding up the caller. Inside a request
 * it runs after the response is sent (`after`); elsewhere on the next tick.
 * Serverless deployments also call it from the cron route, which is what
 * picks up retries.
 */
export function kickDispatcher(): void {
  if (!autoKick) return;
  if (running) {
    again = true;
    return;
  }
  const run = (): Promise<unknown> => {
    running = dispatchDue().finally(() => {
      running = null;
      if (again) {
        again = false;
        void run().catch(() => undefined);
      }
    });
    return running;
  };
  afterResponse("webhooks: dispatch", run);
}

export { MAX_DELIVERY_ATTEMPTS };

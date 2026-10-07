import "server-only";

import {
  isDuplicateKeyError,
  newId,
  serializeEvent,
  sha256Hex,
  type MerchantRecord,
  type WebhookDeliveryRecord,
  type WebhookEventRecord,
  type WebhookEventType,
  type WebhookSource,
} from "@polaris/db";

import { getDb } from "../db";
import { kickDispatcher } from "./dispatcher";

/**
 * Emit a webhook event: store it once, and queue one delivery per endpoint
 * that subscribed to its type.
 *
 * Every live event comes from a chain log the server has seen (a relayed
 * transaction's receipt, or the chain sync) or from the Envio indexer's
 * `Activity` outbox for that same log (./outbox.ts), never from a browser.
 * Its id is derived from that log (`sourceKey`), so seeing the same log
 * twice (the receipt, the sync, the outbox) can't send the event twice: the
 * first insert wins and the others find it. Each event and its deliveries
 * record which source got there first.
 */

export type EmitInput = {
  merchant: MerchantRecord;
  type: WebhookEventType;
  data: Record<string, unknown>;
  /** `<txHash>:<logIndex>:<type>` for a chain event; omit for a test event. */
  sourceKey?: string;
  /** Only this endpoint (the dashboard's "Send test event"). */
  endpointId?: string;
  /** What fed it: the chain sync unless said (a test event is always "test"). */
  source?: Exclude<WebhookSource, "test">;
  now?: Date;
};

export function eventIdFor(sourceKey: string): string {
  return `evt_${sha256Hex(sourceKey).slice(0, 28)}`;
}

export async function emitEvent(input: EmitInput): Promise<{ event: WebhookEventRecord; deliveries: WebhookDeliveryRecord[]; duplicate: boolean }> {
  const db = getDb();
  const now = input.now ?? new Date();
  const test = input.sourceKey === undefined;
  const source: WebhookSource = test ? "test" : (input.source ?? "chain");
  const id = test ? newId("evt", 24) : eventIdFor(input.sourceKey as string);
  const createdAt = now.toISOString();
  const body = serializeEvent({
    id,
    object: "event",
    type: input.type,
    createdAt,
    livemode: false,
    merchantId: input.merchant.publicId,
    data: input.data,
  });
  const record: WebhookEventRecord = {
    id,
    merchantId: input.merchant.id,
    type: input.type,
    livemode: false,
    createdAt,
    body,
    sourceKey: input.sourceKey ?? `test:${id}`,
    test,
    source,
  };
  try {
    await db.webhookEvents.insert(record);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { event: (await db.webhookEvents.get(id)) as WebhookEventRecord, deliveries: [], duplicate: true };
    }
    throw error;
  }

  const endpoints = (await db.webhookEndpoints.find({ merchantId: input.merchant.id })).filter(
    (e) => !e.disabledAt && (input.endpointId ? e.id === input.endpointId : e.events.includes(input.type)),
  );
  const deliveries: WebhookDeliveryRecord[] = [];
  for (const endpoint of endpoints) {
    deliveries.push(
      await db.webhookDeliveries.insert({
        id: newId("del", 20),
        merchantId: input.merchant.id,
        endpointId: endpoint.id,
        eventId: id,
        type: input.type,
        url: endpoint.url,
        state: "pending",
        attempts: [],
        nextAttemptAtMs: now.getTime(),
        lockedUntilMs: 0,
        request: null,
        test,
        source,
        createdAt,
        updatedAt: createdAt,
      }),
    );
  }
  if (deliveries.length > 0) kickDispatcher();
  return { event: record, deliveries, duplicate: false };
}

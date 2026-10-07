import { randomBytes } from "node:crypto";

import type { OrderStore, StoreData } from "./store";

/**
 * The order store on a Redis REST API (Upstash, which Vercel's marketplace
 * integration provisions), for serverless hosts.
 *
 * On Vercel every function instance has its own memory and a read-only disk,
 * so the file store falls back to memory per instance: the checkout would
 * create an order in one instance and the Polaris webhook would mark it paid
 * in another, and the order page would never see it paid. Here every
 * instance reads and writes the same record.
 *
 * One key holds the whole StoreData, as the file store holds one file.
 * `update` takes a lock first (SET NX PX, released only by its holder), so a
 * webhook in one instance and a page poll in another never interleave a
 * read-modify-write; inside one instance updates also queue, as they do in
 * the other stores. The demo keeps the newest `maxOrders` orders (and the
 * newest events) so the record stays small; older ones are dropped.
 */

export type RedisRestOptions = {
  /** The REST endpoint, e.g. https://<name>.upstash.io (KV_REST_API_URL or UPSTASH_REDIS_REST_URL). */
  url: string;
  /** The read-write token (KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN). */
  token: string;
  /** The record's key. Separate deployments (production, previews) should use separate keys. */
  key: string;
  maxOrders?: number;
  maxEvents?: number;
  /** How long a lock is held at most, if its holder dies mid-update. */
  lockTtlMs?: number;
  /** How long `update` waits for another instance's lock before giving up. */
  lockWaitMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type RedisReply = { result?: unknown; error?: string };

const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const empty = (): StoreData => ({ orders: {}, idempotency: {}, events: {} });

export class RedisRestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisRestError";
  }
}

/** Keep the newest orders and events; drop idempotency keys that point at dropped orders. */
export function prune(data: StoreData, maxOrders: number, maxEvents: number): StoreData {
  const orders = Object.entries(data.orders);
  if (orders.length > maxOrders) {
    orders.sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt));
    data.orders = Object.fromEntries(orders.slice(0, maxOrders));
    for (const [key, entry] of Object.entries(data.idempotency)) {
      if (!data.orders[entry.orderId]) delete data.idempotency[key];
    }
  }
  const events = Object.entries(data.events);
  if (events.length > maxEvents) {
    events.sort(([, a], [, b]) => b.receivedAt.localeCompare(a.receivedAt));
    data.events = Object.fromEntries(events.slice(0, maxEvents));
  }
  return data;
}

export function createRedisStore(options: RedisRestOptions): OrderStore {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const lockKey = `${options.key}:lock`;
  const lockTtlMs = options.lockTtlMs ?? 10_000;
  const lockWaitMs = options.lockWaitMs ?? 8_000;
  const maxOrders = options.maxOrders ?? 200;
  const maxEvents = options.maxEvents ?? 2_000;
  let queue: Promise<unknown> = Promise.resolve();

  async function command(...args: (string | number)[]): Promise<unknown> {
    const res = await doFetch(base, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(args.map(String)),
      cache: "no-store",
    });
    let reply: RedisReply;
    try {
      reply = (await res.json()) as RedisReply;
    } catch {
      throw new RedisRestError(`The order store answered ${res.status} without JSON.`);
    }
    if (!res.ok || reply.error) throw new RedisRestError(`The order store refused ${String(args[0])}: ${reply.error ?? res.status}`);
    return reply.result ?? null;
  }

  async function load(): Promise<StoreData> {
    const raw = await command("GET", options.key);
    if (typeof raw !== "string") return empty();
    try {
      return { ...empty(), ...(JSON.parse(raw) as Partial<StoreData>) };
    } catch {
      throw new RedisRestError(`The order store's record at ${options.key} isn't JSON.`);
    }
  }

  async function lock(): Promise<string> {
    const holder = randomBytes(12).toString("hex");
    const deadline = now() + lockWaitMs;
    for (let attempt = 0; ; attempt++) {
      if ((await command("SET", lockKey, holder, "NX", "PX", lockTtlMs)) === "OK") return holder;
      if (now() >= deadline) throw new RedisRestError("The order store is busy. Try again in a moment.");
      await sleep(Math.min(250, 25 * 2 ** Math.min(attempt, 4)));
    }
  }

  return {
    async read() {
      await queue.catch(() => {});
      return load();
    },
    update<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const holder = await lock();
        try {
          const draft = await load();
          const result = await fn(draft);
          await command("SET", options.key, JSON.stringify(prune(draft, maxOrders, maxEvents)));
          return result;
        } finally {
          await command("EVAL", RELEASE, 1, lockKey, holder).catch((error) => {
            console.warn("[orders] couldn't release the order store's lock; it expires on its own.", error);
          });
        }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

/** The REST endpoint and token from the environment, under either name Upstash or Vercel gives them. */
export function redisRestFromEnv(env: Record<string, string | undefined>): { url: string; token: string } | null {
  const url = (env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL)?.trim();
  const token = (env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN)?.trim();
  return url && token ? { url, token } : null;
}

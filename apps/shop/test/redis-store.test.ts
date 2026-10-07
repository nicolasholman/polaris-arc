import { describe, expect, it } from "vitest";

import { createRedisStore, prune, RedisRestError, redisRestFromEnv } from "@/lib/orders/redis-store";
import { orderStoreKind, redisKey, type StoreData } from "@/lib/orders/store";

import { baseOrder } from "./helpers";

/**
 * The shop's order store on a serverless host: one Redis record that every
 * function instance shares, behind a lock. The fake below speaks the Upstash
 * REST protocol (a JSON array command, `{ result }` or `{ error }`) for the
 * four commands the store uses.
 */

type Entry = { value: string; expiresAt: number | null };

function fakeRedis(token = "tok") {
  const data = new Map<string, Entry>();
  const commands: string[][] = [];
  let clock = 0;
  const live = (key: string) => {
    const entry = data.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= clock) data.delete(key);
    return data.get(key);
  };
  const fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if ((init?.headers as Record<string, string>).authorization !== `Bearer ${token}`) {
      return Response.json({ error: "WRONGPASS invalid token" }, { status: 401 });
    }
    const args = JSON.parse(String(init?.body)) as string[];
    commands.push(args);
    const [name, ...rest] = args;
    switch (name) {
      case "GET":
        return Response.json({ result: live(rest[0]!)?.value ?? null });
      case "SET": {
        const [key, value, ...opts] = rest as [string, string, ...string[]];
        const nx = opts.includes("NX");
        const px = opts.indexOf("PX");
        if (nx && live(key)) return Response.json({ result: null });
        data.set(key, { value, expiresAt: px >= 0 ? clock + Number(opts[px + 1]) : null });
        return Response.json({ result: "OK" });
      }
      case "EVAL": {
        const [, , key, holder] = rest as [string, string, string, string];
        if (live(key)?.value === holder) {
          data.delete(key);
          return Response.json({ result: 1 });
        }
        return Response.json({ result: 0 });
      }
      default:
        return Response.json({ error: `ERR unknown command '${name}'` }, { status: 400 });
    }
  }) as typeof globalThis.fetch;
  return {
    fetch,
    data,
    commands,
    advance: (ms: number) => {
      clock += ms;
    },
    // Waiting for a lock moves the fake clock instead of the real one.
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

const KEY = "halcyon:test:orders:v1";

function storeOn(redis: ReturnType<typeof fakeRedis>, extra: Partial<Parameters<typeof createRedisStore>[0]> = {}) {
  return createRedisStore({ url: "https://example.upstash.io/", token: "tok", key: KEY, fetch: redis.fetch, sleep: redis.sleep, ...extra });
}

describe("the Redis order store", () => {
  it("starts empty", async () => {
    const redis = fakeRedis();
    expect(await storeOn(redis).read()).toEqual({ orders: {}, idempotency: {}, events: {} });
  });

  it("shows an order written in one function instance to another (a webhook lands where the order isn't cached)", async () => {
    const redis = fakeRedis();
    const checkout = storeOn(redis);
    const webhook = storeOn(redis);
    const order = baseOrder();
    await checkout.update((data) => {
      data.orders[order.id] = order;
    });
    await webhook.update((data) => {
      data.orders[order.id]!.status = "paid";
    });
    expect((await checkout.read()).orders[order.id]?.status).toBe("paid");
  });

  it("loses no update when two instances write at once", async () => {
    const redis = fakeRedis();
    const a = storeOn(redis);
    const b = storeOn(redis);
    const writes = Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? a : b).update((data) => {
        data.events[`evt_${i}`] = { type: "payment.succeeded", receivedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), orderId: null };
      }),
    );
    await Promise.all(writes);
    expect(Object.keys((await a.read()).events)).toHaveLength(20);
    expect(redis.data.has(`${KEY}:lock`)).toBe(false);
  });

  it("returns what the update returns, and writes nothing when it throws (and still lets go of the lock)", async () => {
    const redis = fakeRedis();
    const store = storeOn(redis);
    expect(await store.update(() => 42)).toBe(42);
    await expect(
      store.update((data) => {
        data.orders.x = baseOrder({ id: "x" });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect((await store.read()).orders).toEqual({});
    expect(redis.data.has(`${KEY}:lock`)).toBe(false);
  });

  it("waits out a lock whose holder died, once it expires", async () => {
    const redis = fakeRedis();
    redis.data.set(`${KEY}:lock`, { value: "someone-else", expiresAt: 1_000 });
    await storeOn(redis, { lockWaitMs: 60_000 }).update((data) => {
      data.events.e = { type: "t", receivedAt: "2026-10-01T00:00:00Z", orderId: null };
    });
    expect(JSON.parse(redis.data.get(KEY)!.value).events.e).toBeDefined();
  });

  it("gives up with a plain error when another instance holds the lock too long", async () => {
    const redis = fakeRedis();
    redis.data.set(`${KEY}:lock`, { value: "someone-else", expiresAt: null });
    let now = 0;
    const store = storeOn(redis, {
      lockWaitMs: 1_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await expect(store.update(() => 1)).rejects.toThrow("The order store is busy");
  });

  it("surfaces a refusal from the REST API", async () => {
    const redis = fakeRedis("the-right-token");
    await expect(storeOn(redis).read()).rejects.toBeInstanceOf(RedisRestError);
  });

  it("keeps the newest orders and events so the record stays small", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString();
    const data: StoreData = {
      orders: { old: baseOrder({ id: "old", createdAt: at(1) }), mid: baseOrder({ id: "mid", createdAt: at(2) }), new: baseOrder({ id: "new", createdAt: at(3) }) },
      idempotency: {
        k1: { orderId: "old", fingerprint: "f", createdAt: at(1) },
        k3: { orderId: "new", fingerprint: "f", createdAt: at(3) },
      },
      events: { e1: { type: "t", receivedAt: at(1), orderId: null }, e2: { type: "t", receivedAt: at(2), orderId: null } },
    };
    const kept = prune(data, 2, 1);
    expect(Object.keys(kept.orders).sort()).toEqual(["mid", "new"]);
    expect(Object.keys(kept.idempotency)).toEqual(["k3"]);
    expect(Object.keys(kept.events)).toEqual(["e2"]);
  });
});

describe("choosing the store", () => {
  it("uses Redis when Vercel's Upstash integration is connected, the file otherwise, and SHOP_ORDER_STORE when set", () => {
    const upstash = { KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" };
    expect(orderStoreKind({})).toBe("file");
    expect(orderStoreKind(upstash)).toBe("redis");
    expect(orderStoreKind({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" })).toBe("redis");
    expect(orderStoreKind({ ...upstash, SHOP_ORDER_STORE: "memory" })).toBe("memory");
    expect(orderStoreKind({ SHOP_ORDER_STORE: "Redis" })).toBe("redis");
    expect(redisRestFromEnv({ KV_REST_API_URL: "https://x.upstash.io" })).toBeNull();
  });

  it("keeps each Vercel environment's orders under its own key", () => {
    expect(redisKey({ VERCEL_ENV: "production" })).toBe("halcyon:production:orders:v1");
    expect(redisKey({ VERCEL_ENV: "preview" })).toBe("halcyon:preview:orders:v1");
    expect(redisKey({})).toBe("halcyon:default:orders:v1");
    expect(redisKey({ SHOP_ORDER_STORE_KEY: "mine", VERCEL_ENV: "production" })).toBe("mine");
  });
});

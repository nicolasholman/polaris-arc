import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RequestSpec } from "../src/core/providers/common.ts";
import { ProviderError, RateLimiter, retryAfterMs, send, TtlCache, type HttpRequest, type HttpTransport } from "../src/node/http.ts";
import { instantClock, status } from "./helpers.ts";

const spec: RequestSpec = { provider: "nansen", endpoint: "first-funder", method: "POST", url: "https://api.nansen.ai/x", headers: {}, body: "{}" };

function sequence(...responses: Array<ReturnType<typeof status> | "network" | "hang">): HttpTransport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const t = (async (req: HttpRequest, signal: AbortSignal) => {
    calls.push(req);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    if (next === "network") throw new TypeError("fetch failed");
    if (next === "hang") {
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return next;
  }) as HttpTransport & { calls: HttpRequest[] };
  t.calls = calls;
  return t;
}

const fast = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000, timeoutMs: 30, maxRetryAfterMs: 5_000 };

describe("send", () => {
  it("retries 5xx with backoff and returns the success", async () => {
    const clock = instantClock();
    const t = sequence(status(500), status(502), status(200, { ok: 1 }));
    const res = await send(spec, { transport: t, clock, retry: fast, random: () => 0 });
    assert.equal(res.status, 200);
    assert.equal(t.calls.length, 3);
    assert.deepEqual(clock.slept, [50, 100], "exponential, jittered on the upper half");
  });

  it("honours Retry-After in seconds (Zerion's warm-up 503) and Nansen's retry_after body", async () => {
    const clock = instantClock();
    const t = sequence(status(503, {}, { "retry-after": "2" }), status(429, { code: "rate_limit_exceeded", retry_after: 1 }), status(200));
    await send(spec, { transport: t, clock, retry: fast });
    assert.deepEqual(clock.slept, [2000, 1000]);
  });

  it("does not make a buyer wait out a long Retry-After; the error says how long", async () => {
    const t = sequence(status(429, {}, { "retry-after": "60" }));
    await assert.rejects(send(spec, { transport: t, clock: instantClock(), retry: fast }), (e: ProviderError) => {
      assert.equal(e.code, "retry_after_too_long");
      assert.equal(e.retryAfterMs, 60_000);
      assert.equal(e.retryable, true);
      return true;
    });
    assert.equal(t.calls.length, 1);
  });

  it("times out a hung request, retries, then gives up with a timeout", async () => {
    const t = sequence("hang");
    await assert.rejects(send(spec, { transport: t, clock: instantClock(), retry: fast }), (e: ProviderError) => e.code === "timeout" && e.attempts === 3);
    assert.equal(t.calls.length, 3);
  });

  it("retries network errors", async () => {
    const t = sequence("network", status(200));
    assert.equal((await send(spec, { transport: t, clock: instantClock(), retry: fast })).status, 200);
  });

  it("returns other 4xx at once for the client to interpret", async () => {
    const t = sequence(status(400, { errors: [{ detail: "not trackable" }] }));
    assert.equal((await send(spec, { transport: t, clock: instantClock(), retry: fast })).status, 400);
    assert.equal(t.calls.length, 1);
  });

  it("caches successes by the request without its secret, so the key never keys the cache", async () => {
    const cache = new TtlCache(60_000, instantClock());
    const t = sequence(status(200, { n: 1 }));
    const authorize = (r: HttpRequest) => ({ ...r, headers: { ...r.headers, apikey: "secret" } });
    await send(spec, { transport: t, clock: instantClock(), cache, authorize });
    await send(spec, { transport: t, clock: instantClock(), cache, authorize });
    assert.equal(t.calls.length, 1, "the second call is a cache hit: one Nansen credit, not two");
    assert.equal(t.calls[0]!.headers.apikey, "secret");
  });

  it("expires cache entries", () => {
    const clock = instantClock();
    const cache = new TtlCache(1000, clock);
    cache.set("k", status(200));
    assert.ok(cache.get("k"));
    clock.t += 1001;
    assert.equal(cache.get("k"), undefined);
  });

  it("spaces request starts to the provider's rate", async () => {
    const clock = instantClock();
    const start = clock.t;
    const limiter = new RateLimiter(340, clock);
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    // Starts at +0, +340 and +680: each later caller waits one gap past the last.
    assert.deepEqual(clock.slept, [340, 340]);
    assert.equal(clock.t - start, 680);
  });

  it("reads Retry-After as an HTTP date too", () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(retryAfterMs(status(503, {}, { "retry-after": new Date(now + 5000).toUTCString() }), now), 5000);
    assert.equal(retryAfterMs(status(503), now), null);
  });
});

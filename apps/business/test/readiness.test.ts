import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as health } from "@/app/api/health/route";
import { GET as ready, POST as readyPost } from "@/app/api/health/ready/route";
import { getDb } from "@/server/db";
import { resetConfig } from "@/server/env";
import { readiness, storeLocation } from "@/server/readiness";
import { startWorkers, stopWorkers } from "@/server/workers";

import { json, params, request, setupServer } from "./helpers/env";

/**
 * GET /api/health/ready: what Fly's health check, the image's HEALTHCHECK
 * and scripts/deploy-check.mjs ask before sending traffic here.
 */

const call = async () => json(await ready(request("GET", "/api/health/ready"), params({})));

let scratch: string;

beforeEach(() => {
  setupServer();
  scratch = mkdtempSync(join(tmpdir(), "polaris-ready-"));
});

afterEach(() => {
  stopWorkers();
  rmSync(scratch, { recursive: true, force: true });
  delete process.env.POLARIS_WORKERS;
  resetConfig();
});

describe("GET /api/health/ready", () => {
  it("is ready with a chain and a readable store, and says an in-memory store won't survive a restart", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.ready).toBe(true);
    expect(data.checks.config.ok).toBe(true);
    expect(data.checks.chain).toMatchObject({ ok: true, id: 31337 });
    expect(data.checks.store).toMatchObject({ ok: true, kind: "memory", persistent: false, path: null });
    expect(data.checks.workers).toMatchObject({ ok: true, enabled: false, running: false });
    expect(data.relayer.mode).toBe("local");
    expect(data.sync).toEqual({ block: null, updatedAt: null, ageSeconds: null });
  });

  it("checks that a SQLite store's folder is writable: a persistent disk", async () => {
    setupServer({ POLARIS_DB_URL: `sqlite:${join(scratch, "polaris.db")}` });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body.data.checks.store).toMatchObject({ ok: true, kind: "sqlite", persistent: true, path: join(scratch, "polaris.db") });
  });

  it("is not ready when the store's folder isn't there (a volume that isn't mounted)", async () => {
    setupServer({ POLARIS_DB_URL: `sqlite:${join(scratch, "not-mounted", "polaris.db")}` });
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body.data.ready).toBe(false);
    expect(res.body.data.checks.store.ok).toBe(false);
    expect(res.body.data.checks.store.detail).toMatch(/not writable/);
  });

  it("is not ready without a chain", async () => {
    setupServer({ POLARIS_DEPLOYMENT_FILE: "does-not-exist.json", RELAYER_MODE: "off" });
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body.data.checks.chain.ok).toBe(false);
    expect(res.body.data.checks.chain.detail).toMatch(/deployment record/i);
  });

  it("is not ready when the environment doesn't parse, and says why", async () => {
    setupServer({ RELAYER_MODE: "sometimes" });
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body.data.checks.config).toEqual({ ok: false, detail: expect.stringMatching(/RELAYER_MODE must be/) });
    expect(res.body.data.relayer.mode).toBe("unknown");
  });

  it("waits for the background loops when POLARIS_WORKERS is on", async () => {
    setupServer({ POLARIS_WORKERS: "1" });
    const before = await call();
    expect(before.status).toBe(503);
    expect(before.body.data.checks.workers).toMatchObject({ ok: false, enabled: true, running: false });

    startWorkers();
    const after = await call();
    expect(after.status).toBe(200);
    expect(after.body.data.checks.workers).toMatchObject({ ok: true, enabled: true, running: true });
  });

  it("reports how long ago the chain sync moved, without gating on it", async () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    await getDb().cursors.upsert({ id: "logs", block: 66_400_000, updatedAt: new Date(now - 90_000).toISOString() });
    const state = await readiness(now);
    expect(state.ready).toBe(true);
    expect(state.sync).toEqual({ block: 66_400_000, updatedAt: "2026-10-01T11:58:30.000Z", ageSeconds: 90 });
  });

  it("answers other methods with a JSON 405", async () => {
    const res = await json(await readyPost(request("POST", "/api/health/ready"), params({})));
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe("method_not_allowed");
  });
});

describe("storeLocation", () => {
  it("reads POLARIS_DB_URL the way @polaris/db opens it", () => {
    expect(storeLocation("memory:")).toEqual({ kind: "memory", path: null });
    expect(storeLocation("sqlite::memory:")).toEqual({ kind: "memory", path: null });
    expect(storeLocation("sqlite:/data/polaris.db")).toMatchObject({ kind: "sqlite" });
    expect(storeLocation("sqlite:.data/polaris.db", scratch).path).toBe(join(scratch, ".data", "polaris.db"));
    expect(storeLocation("polaris.sqlite", scratch)).toEqual({ kind: "sqlite", path: join(scratch, "polaris.sqlite") });
    expect(storeLocation("postgres://db")).toEqual({ kind: "unknown", path: null });
  });
});

describe("GET /api/health build flags", () => {
  it("tells a deploy check the local session is off", async () => {
    const res = await json(await health(request("GET", "/api/health"), params({})));
    expect(res.body.data.build).toMatchObject({ production: false, localSession: false, privy: false, workers: false });
    expect(Object.keys(res.body.data.build).sort()).toEqual(
      ["demoShopUrl", "localSession", "privy", "privyAppId", "privyServerAppId", "production", "workers"].sort(),
    );
    expect(res.body.data.appOrigins).toContain("http://localhost:3000");
  });
});

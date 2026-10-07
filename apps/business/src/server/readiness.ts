import "server-only";

import { accessSync, constants, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { getDb } from "./db";
import { getConfig, type ServerConfig } from "./env";
import { workersRunning } from "./workers";

/**
 * Whether this process can take traffic, for a platform's health check
 * (Fly's `[[http_service.checks]]`, Docker's HEALTHCHECK) and for
 * `scripts/deploy-check.mjs`. It answers from this process alone, with no
 * network call, so a slow RPC or Privy never takes the dashboard out of
 * rotation:
 *
 * - config: the environment parses (a bad RELAYER_MODE throws in getConfig);
 * - chain: a deployment record and an RPC are configured;
 * - store: the store opens and answers a read, and a SQLite file's folder is
 *   writable (a volume mounted read-only, or not at all, fails here);
 * - workers: when POLARIS_WORKERS is on, the background loops are running.
 *
 * Reported but never gating: whether the store survives a restart (memory:
 * does not), the relayer's mode, and how long ago the chain sync last moved
 * its cursor (it needs the RPC, which this check never waits on).
 */

export type ReadinessCheck = { ok: boolean; detail: string };

export type Readiness = {
  ready: boolean;
  checks: {
    config: ReadinessCheck;
    chain: ReadinessCheck & { id: number | null };
    store: ReadinessCheck & { kind: "sqlite" | "memory" | "unknown"; persistent: boolean; path: string | null };
    workers: ReadinessCheck & { enabled: boolean; running: boolean };
  };
  relayer: { mode: "off" | "local" | "privy" | "unknown" };
  sync: { block: number | null; updatedAt: string | null; ageSeconds: number | null };
};

export type StoreLocation = { kind: "sqlite" | "memory" | "unknown"; path: string | null };

/** What a POLARIS_DB_URL names, by the same rules as @polaris/db's openStore. */
export function storeLocation(url: string, cwd = process.cwd()): StoreLocation {
  const trimmed = url.trim();
  if (trimmed === "memory:" || trimmed === "memory") return { kind: "memory", path: null };
  let file: string | null = null;
  if (trimmed.startsWith("sqlite:")) file = trimmed.slice("sqlite:".length);
  else if (/\.(db|sqlite3?)$/i.test(trimmed)) file = trimmed;
  if (file === null) return { kind: "unknown", path: null };
  if (file === ":memory:" || file === "") return { kind: "memory", path: null };
  return { kind: "sqlite", path: isAbsolute(file) ? file : resolve(/*turbopackIgnore: true*/ cwd, file) };
}

/** Whether this process may write the SQLite file (and its -wal and -shm files beside it). */
function writable(path: string): { ok: boolean; detail: string } {
  const dir = dirname(path);
  try {
    accessSync(/*turbopackIgnore: true*/ dir, constants.W_OK);
    if (existsSync(/*turbopackIgnore: true*/ path)) accessSync(/*turbopackIgnore: true*/ path, constants.W_OK);
    return { ok: true, detail: `SQLite at ${path}` };
  } catch (error) {
    return { ok: false, detail: `SQLite at ${path} is not writable by this process (${(error as NodeJS.ErrnoException).code ?? "error"}): is the volume mounted?` };
  }
}

export async function readiness(now = Date.now()): Promise<Readiness> {
  let config: ServerConfig;
  try {
    config = getConfig();
  } catch (error) {
    const detail = (error as Error).message;
    return {
      ready: false,
      checks: {
        config: { ok: false, detail },
        chain: { ok: false, id: null, detail: "Not checked: the configuration doesn't parse." },
        store: { ok: false, kind: "unknown", persistent: false, path: null, detail: "Not checked: the configuration doesn't parse." },
        workers: { ok: false, enabled: false, running: false, detail: "Not checked: the configuration doesn't parse." },
      },
      relayer: { mode: "unknown" },
      sync: { block: null, updatedAt: null, ageSeconds: null },
    };
  }

  const chain = config.chain
    ? { ok: true, id: config.chain.id, detail: `${config.chain.name} (${config.chain.id})` }
    : { ok: false, id: null, detail: config.chainProblem ?? "No chain is configured." };

  const location = storeLocation(config.dbUrl);
  let store: Readiness["checks"]["store"];
  let sync: Readiness["sync"] = { block: null, updatedAt: null, ageSeconds: null };
  try {
    const cursor = await getDb().cursors.get("logs");
    if (cursor) {
      const at = Date.parse(cursor.updatedAt);
      sync = {
        block: cursor.block,
        updatedAt: cursor.updatedAt,
        ageSeconds: Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null,
      };
    }
    const disk = location.kind === "sqlite" && location.path ? writable(location.path) : null;
    store = {
      ok: disk ? disk.ok : location.kind !== "unknown",
      kind: location.kind,
      persistent: location.kind === "sqlite",
      path: location.path,
      detail: disk ? disk.detail : location.kind === "memory" ? "In memory: everything is lost on restart." : "Unrecognised POLARIS_DB_URL.",
    };
  } catch (error) {
    store = {
      ok: false,
      kind: location.kind,
      persistent: location.kind === "sqlite",
      path: location.path,
      detail: `The store can't be read: ${(error as Error).message}`,
    };
  }

  const running = workersRunning();
  const workers = {
    ok: !config.workers || running,
    enabled: config.workers,
    running,
    detail: config.workers
      ? running
        ? "Chain sync, webhooks, payouts and underwriting run in this process."
        : "POLARIS_WORKERS is on but the loops haven't started (see the startup log)."
      : "Off: background work runs only when something calls POST /api/cron/tick.",
  };

  return {
    ready: chain.ok && store.ok && workers.ok,
    checks: { config: { ok: true, detail: "The environment parses." }, chain, store, workers },
    relayer: { mode: config.relayer.mode },
    sync,
  };
}

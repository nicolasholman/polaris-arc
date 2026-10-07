import "server-only";

import { collections, openMemoryStore, openStore, type Collections, type Store } from "@polaris/db";

import { getConfig } from "./env";

/**
 * The one store for this process: SQLite at `POLARIS_DB_URL` (default
 * `sqlite:.data/polaris.db` under apps/business), or `memory:`.
 *
 * Kept on `globalThis` so a dev-server hot reload reuses the open database.
 * Tests swap in a fresh in-memory store with `replaceStoreForTests`.
 */

type Holder = { store: Store; db: Collections };
const g = globalThis as typeof globalThis & { __polarisDb?: Holder };

export function getDb(): Collections {
  if (!g.__polarisDb) {
    const store = openStore(getConfig().dbUrl);
    g.__polarisDb = { store, db: collections(store) };
  }
  return g.__polarisDb.db;
}

export function replaceStoreForTests(store: Store = openMemoryStore()): Collections {
  g.__polarisDb?.store.close();
  g.__polarisDb = { store, db: collections(store) };
  return g.__polarisDb.db;
}

export * from "./types.ts";
export { MemoryStore, openMemoryStore } from "./memory.ts";
export { SqliteStore, openSqliteStore } from "./sqlite.ts";

import { openMemoryStore } from "./memory.ts";
import { openSqliteStore } from "./sqlite.ts";
import type { Store } from "./types.ts";

/**
 * Open the store a URL names: `sqlite:<path>` (or a bare path ending in .db
 * / .sqlite), `sqlite::memory:`, or `memory:`.
 */
export function openStore(url: string): Store {
  const trimmed = url.trim();
  if (trimmed === "memory:" || trimmed === "memory") return openMemoryStore();
  if (trimmed.startsWith("sqlite:")) return openSqliteStore(trimmed.slice("sqlite:".length));
  if (/\.(db|sqlite3?)$/i.test(trimmed)) return openSqliteStore(trimmed);
  throw new Error(`Unrecognised store URL ${JSON.stringify(url)}: use sqlite:<path> or memory:`);
}

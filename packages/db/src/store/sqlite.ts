import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  assertName,
  type Collection,
  type CollectionSpec,
  type FindOptions,
  DuplicateKeyError,
  normaliseIndexValue,
  type Store,
  toRange,
  type Where,
} from "./types.ts";

/**
 * The SQLite store, on Node's built-in `node:sqlite` (Node 22.13+): no native
 * module to build, nothing to install.
 *
 * One table per collection: `id`, the JSON document, and one column per
 * declared index (computed from the document on every write), each with its
 * own SQL index. A collection that gains an index later gets the column added
 * and back-filled when it is first opened.
 *
 * The API is synchronous underneath, so a read-modify-write inside one call
 * can't interleave with another request in this process; `BEGIN IMMEDIATE`
 * covers other processes sharing the file (WAL mode, 5 s busy timeout).
 */

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, unknown>;
type Statement = {
  run(...params: SqlValue[]): { changes: number | bigint };
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
};
type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};
type SqliteModule = { DatabaseSync: new (path: string) => Database };

/**
 * `process.getBuiltinModule` keeps bundlers (Next, Vite) from trying to
 * resolve `node:sqlite` themselves. Node prints an ExperimentalWarning the
 * first time the module loads; that one warning is dropped.
 */
function loadSqlite(): SqliteModule {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== "function") throw new Error("@polaris/db needs Node 22.13 or later (node:sqlite).");
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const mod = getBuiltin("node:sqlite") as SqliteModule | undefined;
    if (!mod?.DatabaseSync) throw new Error("node:sqlite is unavailable in this Node build.");
    return mod;
  } finally {
    process.emitWarning = original;
  }
}

const q = (name: string) => `"${name}"`;
const col = (field: string) => (field === "id" ? "id" : q(`ix_${field}`));

function toSql(value: string | number | boolean | null | undefined): SqlValue {
  return normaliseIndexValue(value ?? null);
}

class SqliteCollection<T> implements Collection<T> {
  readonly name: string;
  private readonly db: Database;
  private readonly spec: CollectionSpec<T>;
  private readonly table: string;
  private readonly fields: string[];
  private readonly stmt: {
    get: Statement;
    insert: Statement;
    upsert: Statement;
    replace: Statement;
    delete: Statement;
  };

  constructor(db: Database, spec: CollectionSpec<T>) {
    assertName("collection", spec.name);
    this.db = db;
    this.spec = spec;
    this.name = spec.name;
    this.table = q(`c_${spec.name}`);
    this.fields = Object.keys(spec.indexes);
    for (const f of this.fields) assertName("index", f);
    this.migrate();

    const columns = ["id", "doc", ...this.fields.map(col)];
    const placeholders = columns.map(() => "?").join(", ");
    const sets = ["doc = excluded.doc", ...this.fields.map((f) => `${col(f)} = excluded.${col(f)}`)].join(", ");
    this.stmt = {
      get: db.prepare(`SELECT doc FROM ${this.table} WHERE id = ?`),
      insert: db.prepare(`INSERT INTO ${this.table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO NOTHING`),
      upsert: db.prepare(`INSERT INTO ${this.table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${sets}`),
      replace: db.prepare(
        `UPDATE ${this.table} SET doc = ?${this.fields.map((f) => `, ${col(f)} = ?`).join("")} WHERE id = ?`,
      ),
      delete: db.prepare(`DELETE FROM ${this.table} WHERE id = ?`),
    };
  }

  /** Create the table, add any index column it lacks, and back-fill it. */
  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (id TEXT PRIMARY KEY NOT NULL, doc TEXT NOT NULL)`);
    const existing = new Set(
      this.db
        .prepare(`PRAGMA table_info(${this.table})`)
        .all()
        .map((r) => String(r.name)),
    );
    const added: string[] = [];
    for (const f of this.fields) {
      if (!existing.has(`ix_${f}`)) {
        try {
          this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN ${col(f)}`);
          added.push(f);
        } catch (error) {
          // Another process sharing the file added it first.
          if (!/duplicate column/i.test((error as Error).message)) throw error;
        }
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${q(`i_${this.spec.name}_${f}`)} ON ${this.table} (${col(f)})`);
    }
    if (added.length > 0) {
      const rows = this.db.prepare(`SELECT id, doc FROM ${this.table}`).all();
      const set = this.db.prepare(`UPDATE ${this.table} SET ${added.map((f) => `${col(f)} = ?`).join(", ")} WHERE id = ?`);
      this.inTransaction(() => {
        for (const r of rows) {
          const doc = JSON.parse(String(r.doc)) as T;
          set.run(...added.map((f) => toSql(this.spec.indexes[f]?.(doc))), String(r.id));
        }
      });
    }
  }

  private inTransaction<R>(fn: () => R): R {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private values(doc: T): SqlValue[] {
    return this.fields.map((f) => toSql(this.spec.indexes[f]?.(doc)));
  }

  private parse(row: Row | undefined): T | null {
    return row ? (JSON.parse(String(row.doc)) as T) : null;
  }

  async get(id: string): Promise<T | null> {
    return this.parse(this.stmt.get.get(id));
  }

  async insert(doc: T): Promise<T> {
    const id = this.spec.id(doc);
    const json = JSON.stringify(doc);
    const { changes } = this.stmt.insert.run(id, json, ...this.values(doc));
    if (Number(changes) === 0) throw new DuplicateKeyError(this.name, id);
    return JSON.parse(json) as T;
  }

  async upsert(doc: T): Promise<T> {
    const json = JSON.stringify(doc);
    this.stmt.upsert.run(this.spec.id(doc), json, ...this.values(doc));
    return JSON.parse(json) as T;
  }

  async update(id: string, change: (current: T) => T): Promise<T | null> {
    return this.inTransaction(() => {
      const current = this.parse(this.stmt.get.get(id));
      if (current === null) return null;
      const next = change(current);
      if (this.spec.id(next) !== id) throw new Error(`${this.name}: update must not change the id`);
      const json = JSON.stringify(next);
      this.stmt.replace.run(json, ...this.values(next), id);
      return JSON.parse(json) as T;
    });
  }

  async delete(id: string): Promise<boolean> {
    return Number(this.stmt.delete.run(id).changes) > 0;
  }

  private whereSql(where: Where = {}): { sql: string; params: SqlValue[] } {
    const parts: string[] = [];
    const params: SqlValue[] = [];
    for (const [field, condition] of Object.entries(where)) {
      if (field !== "id" && !this.spec.indexes[field]) throw new Error(`${this.name}: "${field}" is not an indexed field`);
      const c = toRange(condition);
      const column = col(field);
      if ("eq" in c) {
        const v = toSql(c.eq);
        if (v === null) parts.push(`${column} IS NULL`);
        else {
          parts.push(`${column} = ?`);
          params.push(v);
        }
      }
      if ("ne" in c) {
        const v = toSql(c.ne);
        if (v === null) parts.push(`${column} IS NOT NULL`);
        else {
          parts.push(`${column} IS NOT NULL AND ${column} != ?`);
          params.push(v);
        }
      }
      for (const [op, sqlOp] of [
        ["lt", "<"],
        ["lte", "<="],
        ["gt", ">"],
        ["gte", ">="],
      ] as const) {
        const bound = c[op];
        if (bound === undefined) continue;
        parts.push(`${column} ${sqlOp} ?`);
        params.push(bound);
      }
      if (c.in !== undefined) {
        const values = c.in.map((v) => toSql(v)).filter((v): v is Exclude<SqlValue, null> => v !== null);
        if (values.length === 0) parts.push("0");
        else {
          parts.push(`${column} IN (${values.map(() => "?").join(", ")})`);
          params.push(...values);
        }
      }
    }
    return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
  }

  async find(where: Where = {}, options: FindOptions = {}): Promise<T[]> {
    const { sql, params } = this.whereSql(where);
    const orderBy = options.orderBy ?? "id";
    if (orderBy !== "id" && !this.spec.indexes[orderBy]) throw new Error(`${this.name}: "${orderBy}" is not an indexed field`);
    const dir = options.direction === "desc" ? "DESC" : "ASC";
    let tail = ` ORDER BY ${col(orderBy)} ${dir}, id ${dir}`;
    if (options.limit !== undefined || options.offset !== undefined) {
      tail += ` LIMIT ? OFFSET ?`;
      params.push(options.limit ?? -1, options.offset ?? 0);
    }
    return this.db
      .prepare(`SELECT doc FROM ${this.table} ${sql}${tail}`)
      .all(...params)
      .map((r) => JSON.parse(String(r.doc)) as T);
  }

  async findOne(where: Where, options: FindOptions = {}): Promise<T | null> {
    return (await this.find(where, { ...options, limit: 1 }))[0] ?? null;
  }

  async count(where: Where = {}): Promise<number> {
    const { sql, params } = this.whereSql(where);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.table} ${sql}`).get(...params);
    return Number(row?.n ?? 0);
  }
}

export class SqliteStore implements Store {
  readonly kind = "sqlite";
  private readonly db: Database;
  private readonly collections = new Map<string, SqliteCollection<unknown>>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
  }

  collection<T>(spec: CollectionSpec<T>): Collection<T> {
    let found = this.collections.get(spec.name);
    if (!found) {
      found = new SqliteCollection(this.db, spec as CollectionSpec<unknown>);
      this.collections.set(spec.name, found);
    }
    return found as unknown as Collection<T>;
  }

  close(): void {
    this.collections.clear();
    this.db.close();
  }
}

/** Open (creating if needed) a SQLite database file. ":memory:" for a throwaway one. */
export function openSqliteStore(path: string): Store {
  return new SqliteStore(path);
}

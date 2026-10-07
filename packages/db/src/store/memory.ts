import {
  assertName,
  type Collection,
  type CollectionSpec,
  DuplicateKeyError,
  type FindOptions,
  normaliseIndexValue,
  type Store,
  toRange,
  type Where,
} from "./types.ts";

/**
 * The in-memory store: tests, and a server started without a database path.
 * It answers every query exactly as the SQLite store does (same NULL and
 * ordering rules), so a test that passes here passes against SQLite.
 */

type Scalar = string | number | null;

/** SQLite's ordering: NULL, then numbers, then text. */
export function compareScalars(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) => (v === null ? 0 : typeof v === "number" ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a === null || b === null) return 0;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Whether an indexed value passes a condition, with SQL's NULL semantics. */
export function matches(value: Scalar, condition: Where[string]): boolean {
  const c = toRange(condition);
  if ("eq" in c) {
    const target = normaliseIndexValue(c.eq);
    if (target === null ? value !== null : value === null || compareScalars(value, target) !== 0) return false;
  }
  if ("ne" in c) {
    const target = normaliseIndexValue(c.ne);
    if (target === null ? value === null : value === null || compareScalars(value, target) === 0) return false;
  }
  const ranges: Array<[keyof typeof c, (cmp: number) => boolean]> = [
    ["lt", (x) => x < 0],
    ["lte", (x) => x <= 0],
    ["gt", (x) => x > 0],
    ["gte", (x) => x >= 0],
  ];
  for (const [op, ok] of ranges) {
    const bound = c[op];
    if (bound === undefined) continue;
    if (value === null) return false;
    if (!ok(compareScalars(value, bound as Scalar))) return false;
  }
  if (c.in !== undefined) {
    if (value === null) return false;
    if (!c.in.some((v) => v !== null && compareScalars(value, normaliseIndexValue(v)) === 0)) return false;
  }
  return true;
}

class MemoryCollection<T> implements Collection<T> {
  readonly name: string;
  private readonly docs = new Map<string, string>();
  private readonly spec: CollectionSpec<T>;

  constructor(spec: CollectionSpec<T>) {
    assertName("collection", spec.name);
    for (const f of Object.keys(spec.indexes)) assertName("index", f);
    this.spec = spec;
    this.name = spec.name;
  }

  private read(json: string): T {
    return JSON.parse(json) as T;
  }

  private indexOf(doc: T, field: string): Scalar {
    if (field === "id") return this.spec.id(doc);
    const fn = this.spec.indexes[field];
    if (!fn) throw new Error(`${this.name}: "${field}" is not an indexed field`);
    return normaliseIndexValue(fn(doc));
  }

  async get(id: string): Promise<T | null> {
    const json = this.docs.get(id);
    return json === undefined ? null : this.read(json);
  }

  async insert(doc: T): Promise<T> {
    const id = this.spec.id(doc);
    if (this.docs.has(id)) throw new DuplicateKeyError(this.name, id);
    this.docs.set(id, JSON.stringify(doc));
    return this.read(this.docs.get(id) as string);
  }

  async upsert(doc: T): Promise<T> {
    const id = this.spec.id(doc);
    this.docs.set(id, JSON.stringify(doc));
    return this.read(this.docs.get(id) as string);
  }

  async update(id: string, change: (current: T) => T): Promise<T | null> {
    const json = this.docs.get(id);
    if (json === undefined) return null;
    const next = change(this.read(json));
    if (this.spec.id(next) !== id) throw new Error(`${this.name}: update must not change the id`);
    this.docs.set(id, JSON.stringify(next));
    return this.read(this.docs.get(id) as string);
  }

  async delete(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }

  private select(where: Where = {}): T[] {
    const fields = Object.keys(where);
    for (const f of fields) if (f !== "id" && !this.spec.indexes[f]) throw new Error(`${this.name}: "${f}" is not an indexed field`);
    const out: T[] = [];
    for (const json of this.docs.values()) {
      const doc = this.read(json);
      if (fields.every((f) => matches(this.indexOf(doc, f), where[f] as Where[string]))) out.push(doc);
    }
    return out;
  }

  async find(where: Where = {}, options: FindOptions = {}): Promise<T[]> {
    let rows = this.select(where);
    const orderBy = options.orderBy ?? "id";
    const dir = options.direction === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const primary = compareScalars(this.indexOf(a, orderBy), this.indexOf(b, orderBy)) * dir;
      return primary !== 0 ? primary : compareScalars(this.spec.id(a), this.spec.id(b)) * dir;
    });
    const offset = options.offset ?? 0;
    rows = rows.slice(offset, options.limit === undefined ? undefined : offset + options.limit);
    return rows;
  }

  async findOne(where: Where, options: FindOptions = {}): Promise<T | null> {
    return (await this.find(where, { ...options, limit: 1 }))[0] ?? null;
  }

  async count(where: Where = {}): Promise<number> {
    return this.select(where).length;
  }
}

export class MemoryStore implements Store {
  readonly kind = "memory";
  private readonly collections = new Map<string, MemoryCollection<unknown>>();

  collection<T>(spec: CollectionSpec<T>): Collection<T> {
    let found = this.collections.get(spec.name);
    if (!found) {
      found = new MemoryCollection(spec as CollectionSpec<unknown>);
      this.collections.set(spec.name, found);
    }
    return found as unknown as Collection<T>;
  }

  close(): void {
    this.collections.clear();
  }
}

export function openMemoryStore(): Store {
  return new MemoryStore();
}

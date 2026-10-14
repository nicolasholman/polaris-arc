import { MongoClient, type Collection as MongoCollection, type Filter } from "mongodb";
import { assertName, DuplicateKeyError, normaliseIndexValue, toRange, type Collection, type CollectionSpec, type FindOptions, type Store, type Where } from "./types.ts";

type Row = { _id: string; version: number; json: string; indexes: Record<string, string | number | null> };

/** Durable document store for stateless Vercel instances. Updates use optimistic
 * versions; change callbacks must be pure because a concurrent writer retries them. */
export class MongoStore implements Store {
  readonly kind = "mongodb";
  private client: MongoClient;
  private database: string;
  constructor(url: string) {
    const name = process.env.POLARIS_MONGO_DB || "arc_polaris_testnet";
    if (!/^arc_[a-z0-9_]+$/.test(name)) throw new Error("POLARIS_MONGO_DB must start with arc_");
    this.database = name;
    this.client = new MongoClient(url, { maxPoolSize: 3, serverSelectionTimeoutMS: 10_000 });
  }
  collection<T>(spec: CollectionSpec<T>): Collection<T> {
    assertName("collection", spec.name);
    for (const key of Object.keys(spec.indexes)) assertName("index", key);
    return new MongoDocuments(this.client.db(this.database).collection<Row>(spec.name), spec);
  }
  close(): void { void this.client.close(); }
}

class MongoDocuments<T> implements Collection<T> {
  readonly name: string;
  private rows: MongoCollection<Row>;
  private spec: CollectionSpec<T>;
  constructor(rows: MongoCollection<Row>, spec: CollectionSpec<T>) { this.rows = rows; this.spec = spec; this.name = spec.name; }
  private row(doc: T, version: number): Row {
    return { _id: this.spec.id(doc), version, json: JSON.stringify(doc), indexes: Object.fromEntries(Object.entries(this.spec.indexes).map(([key, value]) => [key, normaliseIndexValue(value(doc))])) };
  }
  private field(key: string): string {
    if (key === "id") return "_id";
    if (!this.spec.indexes[key]) throw new Error(`${this.name}: ${key} is not an indexed field`);
    return `indexes.${key}`;
  }
  private filter(where: Where): Filter<Row> {
    const clauses: Record<string, unknown>[] = [];
    for (const [key, value] of Object.entries(where)) {
      const field = this.field(key), range = toRange(value);
      for (const [op, bound] of Object.entries(range)) {
        if (op === "in") clauses.push({ [field]: { $in: (bound as Array<string | number | boolean | null>).filter(v => v !== null).map(normaliseIndexValue) } });
        else {
          const normalized = normaliseIndexValue(bound as string | number | boolean | null);
          clauses.push({ [field]: { [`$${op}`]: normalized } });
          if (op !== "eq" && normalized !== null) clauses.push({ [field]: { $ne: null } });
        }
      }
    }
    return clauses.length ? { $and: clauses } as Filter<Row> : {};
  }
  async get(id: string): Promise<T | null> { const row = await this.rows.findOne({ _id: id }); return row ? JSON.parse(row.json) : null; }
  async insert(doc: T): Promise<T> {
    const row = this.row(doc, 1);
    try { await this.rows.insertOne(row); }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new DuplicateKeyError(this.name, row._id); throw error; }
    return JSON.parse(row.json);
  }
  async upsert(doc: T): Promise<T> {
    const row = this.row(doc, 1);
    await this.rows.updateOne({ _id: row._id }, { $set: { json: row.json, indexes: row.indexes }, $inc: { version: 1 } }, { upsert: true });
    return JSON.parse(row.json);
  }
  async update(id: string, change: (current: T) => T): Promise<T | null> {
    for (let attempt = 0; attempt < 24; attempt++) {
      const row = await this.rows.findOne({ _id: id });
      if (!row) return null;
      const next = this.row(change(JSON.parse(row.json)), row.version + 1);
      if (next._id !== id) throw new Error(`${this.name}: update must not change the id`);
      const result = await this.rows.replaceOne({ _id: id, version: row.version }, next);
      if (result.modifiedCount) return JSON.parse(next.json);
    }
    throw new Error(`${this.name}: concurrent update contention; retry`);
  }
  async delete(id: string): Promise<boolean> { return (await this.rows.deleteOne({ _id: id })).deletedCount === 1; }
  async find(where: Where = {}, options: FindOptions = {}): Promise<T[]> {
    const dir = options.direction === "desc" ? -1 : 1;
    const field = this.field(options.orderBy || "id");
    const cursor = this.rows.find(this.filter(where)).sort(field === "_id" ? { _id: dir } : { [field]: dir, _id: dir });
    if (options.offset) cursor.skip(options.offset);
    if (options.limit === 0) return [];
    if (options.limit !== undefined) cursor.limit(options.limit);
    return (await cursor.toArray()).map(row => JSON.parse(row.json));
  }
  async findOne(where: Where, options: FindOptions = {}): Promise<T | null> { return (await this.find(where, { ...options, limit: 1 }))[0] ?? null; }
  async count(where: Where = {}): Promise<number> { return this.rows.countDocuments(this.filter(where)); }
}

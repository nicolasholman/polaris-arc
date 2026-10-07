/**
 * A small document store.
 *
 * Every record is a JSON document with a string id, kept in a named
 * collection. A collection declares the fields it can be queried by (its
 * indexes); queries are equality or range tests on those fields only, so the
 * SQLite implementation can answer every one from an index and the in-memory
 * one behaves identically.
 *
 * Atomicity is per document: `update` reads, applies a synchronous function
 * and writes in one step (one SQLite transaction; one uninterrupted turn of
 * the event loop in memory). Everything Polaris needs to be atomic is shaped
 * to fit that: an idempotency key is claimed by `insert`, a webhook delivery
 * by an `update` that sets its lock.
 */

/** A value an index column can hold. Booleans are stored as 0 and 1. */
export type IndexValue = string | number | boolean | null;

/** Equality, or a range / set test, on one indexed field. */
export type Condition =
  | IndexValue
  | {
      eq?: IndexValue;
      ne?: IndexValue;
      lt?: string | number;
      lte?: string | number;
      gt?: string | number;
      gte?: string | number;
      in?: readonly IndexValue[];
    };

export type Where = Readonly<Record<string, Condition>>;

export type FindOptions = {
  /** An indexed field, or "id". */
  orderBy?: string;
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export type CollectionSpec<T> = {
  /** Lower-case letters, digits and underscores: it becomes a table name. */
  name: string;
  /** The document's primary key. */
  id: (doc: T) => string;
  /** Queryable fields, each computed from the document at write time. */
  indexes: Readonly<Record<string, (doc: T) => IndexValue>>;
};

export interface Collection<T> {
  readonly name: string;
  get(id: string): Promise<T | null>;
  /** Insert a new document. Throws `DuplicateKeyError` if the id exists. */
  insert(doc: T): Promise<T>;
  /** Insert or replace. */
  upsert(doc: T): Promise<T>;
  /**
   * Read, change and write one document atomically. `change` must be
   * synchronous and must not change the id. Returns the new document, or
   * null when there was none. Return `current` unchanged to skip the write.
   */
  update(id: string, change: (current: T) => T): Promise<T | null>;
  delete(id: string): Promise<boolean>;
  find(where?: Where, options?: FindOptions): Promise<T[]>;
  findOne(where: Where, options?: FindOptions): Promise<T | null>;
  count(where?: Where): Promise<number>;
}

export interface Store {
  /** "sqlite" or "memory". */
  readonly kind: string;
  collection<T>(spec: CollectionSpec<T>): Collection<T>;
  close(): void;
}

export class DuplicateKeyError extends Error {
  readonly collection: string;
  readonly id: string;
  constructor(collection: string, id: string) {
    super(`${collection}: a document with id ${JSON.stringify(id)} already exists`);
    this.name = "DuplicateKeyError";
    this.collection = collection;
    this.id = id;
  }
}

/**
 * True for a DuplicateKeyError from any copy of this module. A bundler can
 * load a package twice (Next.js builds instrumentation and route handlers
 * separately) while both share one store, so `instanceof` alone isn't enough.
 */
export function isDuplicateKeyError(error: unknown): error is DuplicateKeyError {
  return error instanceof DuplicateKeyError || (error instanceof Error && error.name === "DuplicateKeyError");
}

/** Collections become table names: lower case. Index fields become columns: camelCase allowed. */
const NAMES: Record<string, RegExp> = {
  collection: /^[a-z][a-z0-9_]{0,62}$/,
  index: /^[A-Za-z][A-Za-z0-9_]{0,62}$/,
};

export function assertName(kind: "collection" | "index", name: string): void {
  if (!NAMES[kind]?.test(name)) {
    throw new Error(`Invalid ${kind} name ${JSON.stringify(name)}: use ${kind === "collection" ? "a-z" : "letters"}, 0-9 and _`);
  }
}

/** Normalise a condition to its object form. */
export function toRange(condition: Condition): Exclude<Condition, IndexValue> {
  if (condition === null || typeof condition !== "object") return { eq: condition };
  return condition;
}

/** Index values are compared as SQLite would store them: booleans as 0/1. */
export function normaliseIndexValue(value: IndexValue | undefined): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

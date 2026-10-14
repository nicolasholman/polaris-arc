import { MongoClient } from "mongodb";
import type { OrderStore, StoreData } from "./store";

/** Small demo shop: one versioned Atlas record, shared by all functions. */
export function createMongoOrderStore(): OrderStore {
  const name = process.env.SHOP_MONGO_DB || "arc_polaris_shop_testnet";
  if (!/^arc_[a-z0-9_]+$/.test(name)) throw new Error("SHOP_MONGO_DB must start with arc_");
  const client = new MongoClient(process.env.MONGODB_URI!, { maxPoolSize: 3, serverSelectionTimeoutMS: 10_000 });
  const rows = client.db(name).collection<{ _id: string; version: number; data: StoreData }>("orders");
  const empty = (): StoreData => ({ orders: {}, idempotency: {}, events: {} });
  return {
    async read() { return (await rows.findOne({ _id: "shop" }))?.data ?? empty(); },
    async update<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T> {
      for (let attempt = 0; attempt < 24; attempt++) {
        const current = await rows.findOne({ _id: "shop" });
        const draft = structuredClone(current?.data ?? empty());
        const result = await fn(draft);
        const next = { _id: "shop", version: (current?.version ?? 0) + 1, data: draft };
        if (current) {
          if ((await rows.replaceOne({ _id: "shop", version: current.version }, next)).modifiedCount) return result;
        } else {
          try { await rows.insertOne(next); return result; }
          catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
        }
      }
      throw new Error("Shop is busy; retry the request");
    },
  };
}

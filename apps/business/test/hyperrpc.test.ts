import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { chunkSize, syncChain } from "@/server/ingest/sync";

import { ADDR, setupServer } from "./helpers/env";

/**
 * With POLARIS_LOGS_RPC_URL (Envio's HyperRPC for Monad), the chain sync
 * behind the dashboard, payouts, the buyer's book and every webhook reads
 * its logs from Envio's index, in wide ranges; everything else stays on
 * POLARIS_RPC_URL.
 */

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function hyperRpc(): Promise<{ url: string; calls: Array<{ method: string; params: unknown[] }> }> {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      calls.push({ method: msg.method, params: msg.params });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "eth_chainId" ? "0x7a69" : [] }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, calls };
}

describe("the chain sync on Envio's HyperRPC", () => {
  it("reads logs from POLARIS_LOGS_RPC_URL, for every Polaris contract", async () => {
    const rpc = await hyperRpc();
    const env = setupServer({ POLARIS_LOGS_RPC_URL: rpc.url, POLARIS_SYNC_FROM_BLOCK: "1" });
    env.chain.blockNumber = 5_000n;
    const summary = await syncChain();
    const getLogs = rpc.calls.filter((c) => c.method === "eth_getLogs");
    expect(getLogs).toHaveLength(1); // blocks 1..5000 in one request, not fifty
    const filter = getLogs[0]?.params[0] as { address: string[]; fromBlock: string; toBlock: string };
    expect(filter).toMatchObject({ fromBlock: "0x1", toBlock: "0x1388" });
    expect(filter.address.map((a) => a.toLowerCase())).toContain(ADDR.payments.toLowerCase());
    expect(summary).toMatchObject({ from: 1, to: 5_000, caughtUp: true });
  });

  it("asks for 10,000 blocks a request on HyperRPC and 100 on Monad's public RPC", () => {
    setupServer();
    expect(chunkSize(10143, true)).toBe(10_000);
    expect(chunkSize(10143, false)).toBe(100);
  });
});

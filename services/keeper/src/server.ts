/**
 * The keeper's HTTP side: `POST /underwrite` (the business's signed credit
 * review requests, queued and run one at a time) and `GET /health`.
 * Binds to loopback by default (KEEPER_HOST).
 */

import { createServer, type IncomingMessage, type Server } from "node:http";

import { verify } from "./callback.ts";
import type { KeeperConfig } from "./config.ts";
import { parseReviewRequest, type Reviewer, type ReviewRequest, type ReviewResult } from "./underwriting.ts";

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type KeeperState = { startedAt: string; lastRun: unknown; reviews: ReviewResult[]; queued: number; address: string | null };

export function startServer(config: KeeperConfig, reviewer: Reviewer, state: KeeperState): Server {
  const queue: ReviewRequest[] = [];
  let busy = false;
  const drain = async () => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const r = queue.shift()!;
        state.queued = queue.length;
        try {
          const out = await reviewer.review(r);
          state.reviews = [out, ...state.reviews].slice(0, 20);
          console.log(`[keeper] review ${r.user}: ${out.status}${out.reason ? ` (${out.reason})` : ""}${out.txHash ? ` ${out.txHash}` : ""}`);
        } catch (e) {
          console.error(`[keeper] review ${r.user} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      busy = false;
      state.queued = 0;
    }
  };

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, chainId: config.chainId, ...state });
      if (req.method === "POST" && req.url === "/underwrite") {
        if (!config.requestSecret) return send(503, { error: "POLARIS_KEEPER_CALLBACK_SECRET isn't set: reviews are closed" });
        const body = await readBody(req);
        const check = verify(config.requestSecret, body, req.headers["polaris-signature"] as string | undefined, Math.floor(Date.now() / 1000));
        if (!check.ok) return send(401, { error: `signature: ${check.reason}` });
        let request: ReviewRequest;
        try {
          request = parseReviewRequest(JSON.parse(body));
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : String(e) });
        }
        queue.push(request);
        state.queued = queue.length;
        void drain();
        return send(202, { queued: true, position: queue.length });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(config.http.port, config.http.host);
  return server;
}

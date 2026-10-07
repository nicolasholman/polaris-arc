/**
 * Start the underwriting API on a port. The gateway (apps/gateway) is the
 * process that calls this; tests call it on port 0.
 *
 * `/v1/underwrite` spends provider credits and `/v1/*` answers about any
 * wallet, so without a bearer token the server binds loopback only: asked
 * for any other host with no token, it refuses to start instead of serving
 * an open API with a warning.
 */

import { lookup } from "node:dns/promises";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import { createNodeHandler, type HandlerOptions } from "./handler.ts";
import { Underwriter } from "./service.ts";

export interface ServerOptions extends HandlerOptions {
  port?: number;
  /** Default 127.0.0.1. Anything that is not loopback requires `token`. */
  host?: string;
  underwriter?: Underwriter;
}

function bare(host: string): string {
  return host.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

/** 127.0.0.0/8, ::1 and IPv4-mapped 127.x; false for anything else, including the wildcards. */
export function isLoopbackAddress(address: string): boolean {
  const a = bare(address);
  if (isIP(a) === 4) return a.split(".")[0] === "127";
  if (isIP(a) === 6) {
    if (a === "::1" || /^(0{1,4}:){7}0{0,3}1$/.test(a)) return true;
    const mapped = /^(?:0{0,4}:){0,5}(?::)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    return mapped !== null && isLoopbackAddress(mapped[1]!);
  }
  return false;
}

/**
 * Whether `host` binds loopback only. An IP literal is checked as is; a name
 * must resolve, and every address it resolves to must be loopback. An empty
 * host, 0.0.0.0 and :: bind every interface, so they are not.
 */
export async function isLoopbackHost(host: string): Promise<boolean> {
  const h = bare(host);
  if (h === "") return false;
  if (isIP(h)) return isLoopbackAddress(h);
  try {
    const all = await lookup(h, { all: true });
    return all.length > 0 && all.every((r) => isLoopbackAddress(r.address));
  } catch {
    return false;
  }
}

/** Throws unless the server may bind `host` with this token. */
export async function assertSafeBind(host: string, token: string | undefined): Promise<void> {
  if (token && token.trim() !== "") return;
  if (await isLoopbackHost(host)) return;
  throw new Error(
    `refusing to serve the underwriting API on ${JSON.stringify(host)} without a token: /v1/* would be open to anyone who can reach it. ` +
      "Set UNDERWRITING_API_TOKEN (the app's server sends it as a bearer token), or bind 127.0.0.1.",
  );
}

export async function startUnderwritingServer(opts: ServerOptions = {}): Promise<{ server: Server; url: string; underwriter: Underwriter }> {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token && opts.token.trim() !== "" ? opts.token : undefined;
  await assertSafeBind(host, token);
  const underwriter = opts.underwriter ?? Underwriter.fromEnv();
  const handler = createNodeHandler(underwriter, { ...opts, token });
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal", message: "underwriting failed" } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 3510, host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 3510;
  const shown = isIP(bare(host)) === 6 ? `[${bare(host)}]` : host;
  return { server, url: `http://${shown}:${port}`, underwriter };
}

import { env } from "./env";

/**
 * Calls to Polaris for Business: the relayer and the public checkout reads.
 * Every response is `{ data }` or `{ error: { code, message } }`; the message
 * is written for the buyer and is shown as is.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Whether this build talks to Polaris for Business. Without it the app has
 * no data and nothing to carry a signature: it shows only that Polaris isn't
 * configured (components/not-configured.tsx), and nothing can be signed.
 */
export function apiConfigured(): boolean {
  return Boolean(env.apiUrl);
}

/** What a read or a signature without Polaris for Business throws. */
export const NOT_CONFIGURED_MESSAGE = "Polaris isn't configured on this build, so nothing can be read or signed.";

export async function api<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (!env.apiUrl) throw new ApiError(0, "not_configured", NOT_CONFIGURED_MESSAGE);
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      signal: init.signal ?? AbortSignal.timeout(30_000),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network", "We couldn't reach Polaris. Check your connection; nothing was charged.");
  }
  const payload = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string } } | null;
  if (!res.ok || !payload || !("data" in payload)) {
    throw new ApiError(res.status, payload?.error?.code ?? `http_${res.status}`, payload?.error?.message ?? "That didn't go through, and nothing was charged. Try again.");
  }
  return payload.data as T;
}

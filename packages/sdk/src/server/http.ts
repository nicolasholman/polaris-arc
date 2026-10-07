import { PolarisError, type PolarisErrorType } from "../errors.js";
import { CLIENT_HEADER } from "../version.js";

/**
 * The HTTP client behind `createPolarisServer`.
 *
 * Every response is `{ "data": … }` on success and
 * `{ "error": { "code", "message", "param"? } }` on failure, the shape the
 * Polaris for Business API uses throughout.
 *
 * Retries: network errors, 409 `idempotency_in_progress`, 429 and 5xx, up to
 * `maxRetries` times with exponential backoff and jitter, honouring
 * `Retry-After`. A POST is only ever retried with an Idempotency-Key, which
 * the SDK always sends, so a retry can't create a second session.
 */

export type HttpClientOptions = {
  secretKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** For tests: how to wait between retries. */
  sleep?: (ms: number) => Promise<void>;
};

export type HttpRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type ErrorBody = { error?: { code?: unknown; message?: unknown; param?: unknown } };

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function errorTypeFor(status: number, code: string): PolarisErrorType {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 409 && code.startsWith("idempotency")) return "idempotency_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHttpClient(options: HttpClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? defaultSleep;

  async function request<T>(req: HttpRequest): Promise<T> {
    if (typeof doFetch !== "function") {
      throw new PolarisError("fetch is not available in this runtime; pass `fetch` to createPolarisServer.", {
        type: "configuration_error",
        code: "no_fetch",
      });
    }
    const url = `${baseUrl}${req.path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.secretKey}`,
      Accept: "application/json",
      "Polaris-Client": CLIENT_HEADER,
    };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    if (req.idempotencyKey) headers["Idempotency-Key"] = req.idempotencyKey;
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    const canRetry = req.method === "GET" || !!req.idempotencyKey;

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? options.timeoutMs ?? 30_000);
      const onAbort = () => controller.abort();
      req.signal?.addEventListener("abort", onAbort, { once: true });

      let res: Response;
      try {
        res = await doFetch(url, { method: req.method, headers, body, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        if (req.signal?.aborted) {
          throw new PolarisError("The request was aborted.", { type: "connection_error", code: "aborted", cause: err });
        }
        if (canRetry && attempt < maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        const timedOut = controller.signal.aborted;
        throw new PolarisError(
          timedOut ? `Polaris didn't answer ${req.method} ${req.path} in time.` : `Couldn't reach Polaris at ${baseUrl}.`,
          { type: "connection_error", code: timedOut ? "timeout" : "network_error", cause: err },
        );
      }
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);

      const requestId = res.headers.get("polaris-request-id") ?? res.headers.get("x-request-id") ?? undefined;
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }

      if (res.ok) {
        if (json && typeof json === "object" && "data" in json) return (json as { data: T }).data;
        if (json && typeof json === "object") return json as T;
        throw new PolarisError(`Polaris answered ${req.method} ${req.path} with a body that isn't JSON.`, {
          type: "api_error",
          code: "invalid_response",
          status: res.status,
          requestId,
        });
      }

      const err = (json as ErrorBody | null)?.error;
      const code = typeof err?.code === "string" ? err.code : `http_${res.status}`;
      const retryable = RETRYABLE_STATUS.has(res.status) || (res.status === 409 && code === "idempotency_in_progress");
      if (canRetry && retryable && attempt < maxRetries) {
        await sleep(retryAfter(res) ?? backoff(attempt));
        continue;
      }
      throw new PolarisError(typeof err?.message === "string" ? err.message : `Polaris answered ${res.status} to ${req.method} ${req.path}.`, {
        type: errorTypeFor(res.status, code),
        code,
        status: res.status,
        requestId,
        param: typeof err?.param === "string" ? err.param : undefined,
      });
    }
  }

  return { request, baseUrl };
}

/** 0.5 s, 1 s, 2 s … capped at 8 s, with ±25% jitter. */
function backoff(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function retryAfter(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, Math.min(date - Date.now(), 30_000));
}

export type HttpClient = ReturnType<typeof createHttpClient>;

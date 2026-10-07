/**
 * A GraphQL POST over `fetch`, with the errors Hasura returns surfaced as
 * exceptions. No dependencies: it runs in Node, the browser, Next.js route
 * handlers and edge runtimes. (The CRE workflow cannot use fetch; it sends
 * the same documents through its HTTP capability, see cre.ts.)
 */

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export type TransportOptions = {
  /** The GraphQL endpoint: http://localhost:8080/v1/graphql locally, or `envio-cloud deployment endpoint`. */
  url: string;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Extra headers, e.g. an API key on a paid Envio plan, or x-hasura-admin-secret locally. */
  headers?: Record<string, string>;
  /** Abort a request after this long (default 10 s). */
  timeoutMs?: number;
};

export type GraphQLErrorItem = { message: string; extensions?: Record<string, unknown>; path?: unknown };

export class IndexerError extends Error {
  readonly status: number | undefined;
  readonly errors: readonly GraphQLErrorItem[];
  constructor(message: string, opts: { status?: number; errors?: readonly GraphQLErrorItem[]; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "IndexerError";
    this.status = opts.status;
    this.errors = opts.errors ?? [];
  }
}

export type Request = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

/** JSON-safe variables: bigints become the decimal strings Hasura's `numeric` takes. */
export function serializeVariables(variables: Record<string, unknown>): string {
  return JSON.stringify(variables, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

export function createTransport(options: TransportOptions): Request {
  const fetcher = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetcher) throw new Error("No fetch available: pass `fetch` to the indexer client.");
  if (!/^https?:\/\//.test(options.url)) throw new Error(`The indexer URL must be http(s): ${options.url}`);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetcher(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...options.headers },
        body: `{"query":${JSON.stringify(query)},"variables":${serializeVariables(variables)}}`,
        signal: controller?.signal,
      });
    } catch (cause) {
      throw new IndexerError(`The indexer did not answer (${options.url})`, { cause });
    } finally {
      if (timer) clearTimeout(timer);
    }
    let body: { data?: T; errors?: GraphQLErrorItem[] } | undefined;
    try {
      body = (await res.json()) as typeof body;
    } catch (cause) {
      throw new IndexerError(`The indexer answered HTTP ${res.status} without JSON`, { status: res.status, cause });
    }
    if (body?.errors?.length) {
      throw new IndexerError(body.errors.map((e) => e.message).join("; "), { status: res.status, errors: body.errors });
    }
    if (!res.ok || body?.data === undefined) {
      throw new IndexerError(`The indexer answered HTTP ${res.status}`, { status: res.status });
    }
    return body.data;
  };
}

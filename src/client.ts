import { VERSION } from "./config.js";

/** The parts of a fetch Response the client reads. */
export type HttpReply = { ok: boolean; status: number; text(): Promise<string> };
export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<HttpReply>;

/**
 * An error answered by the INFERVA API, or a transport failure.
 * `code` is the endpoint's error type (e.g. `insufficient_funds`) when it sends one, otherwise a generic code.
 */
export class InfervaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InfervaApiError";
  }
}

export type ClientOptions = { baseUrl: string; apiKey?: string; timeoutMs?: number; fetch?: FetchLike };

const GENERIC: Record<number, string> = { 400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited" };

/** Read the error the API sent. `/v1/*` answers `{ error: { message, type } }`, `/api/*` answers `{ error: "message" }`. */
function parseError(status: number, text: string): InfervaApiError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const err = (body as { error?: unknown } | undefined)?.error;
  const fallback = GENERIC[status] ?? (status >= 500 ? "server_error" : "http_error");
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; type?: unknown };
    return new InfervaApiError(status, typeof e.type === "string" ? e.type : fallback, typeof e.message === "string" ? e.message : `HTTP ${status}`);
  }
  if (typeof err === "string") return new InfervaApiError(status, fallback, err);
  return new InfervaApiError(status, fallback, `HTTP ${status}`);
}

/** Thin HTTP client for the INFERVA app API and the agent endpoint. */
export class InfervaClient {
  readonly baseUrl: string;
  readonly hasKey: boolean;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.hasKey = !!opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  url(path: string, query: Record<string, string | number | undefined> = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    return url.toString();
  }

  private async request<T>(method: "GET" | "POST", url: string, body?: unknown, auth = false): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": `inferva-mcp/${VERSION}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) headers.authorization = `Bearer ${this.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: HttpReply;
    try {
      res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new InfervaApiError(0, "timeout", `No answer within ${this.timeoutMs} ms`);
      throw new InfervaApiError(0, "network_error", err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw parseError(res.status, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new InfervaApiError(res.status, "bad_response", "The API answered with something that is not JSON");
    }
  }

  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>("GET", this.url(path, query));
  }

  /** POST /v1/chat/completions with the agent key. Non-streaming. */
  chat<T = unknown>(body: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) throw new InfervaApiError(0, "missing_api_key", "Set INFERVA_API_KEY (an inf_sk_... agent key) to use chat");
    return this.request<T>("POST", this.url("/v1/chat/completions"), body, true);
  }
}

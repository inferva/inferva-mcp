export const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://dapp.inferva.xyz";

export type Config = {
  /** Origin of the INFERVA app and endpoint. */
  baseUrl: string;
  /** Agent key (`inf_sk_...`) for the `chat` tool. Read tools need no key. */
  apiKey?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
};

function cleanUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`INFERVA_BASE_URL must be an absolute http(s) URL, got "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("INFERVA_BASE_URL must use http or https");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Read configuration from environment variables. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const baseUrl = cleanUrl(env.INFERVA_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const apiKey = env.INFERVA_API_KEY?.trim() || undefined;
  const timeout = Number(env.INFERVA_TIMEOUT_MS ?? 60_000);
  return { baseUrl, apiKey, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000 };
}

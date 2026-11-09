import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InfervaClient, type FetchLike, type HttpReply } from "../src/client.js";
import { createInfervaServer } from "../src/server.js";

export const BASE = "https://inferva.test";
export const GENESIS = "0".repeat(64);

export type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown };
export type Route = { status?: number; body: unknown } | ((call: Call) => { status?: number; body: unknown });

export function reply(body: unknown, status = 200): HttpReply {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/** Fetch stub keyed by "METHOD /path". Records every call. */
export function mockFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const call: Call = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    if (!route) return reply({ error: "Not found" }, 404);
    const { status = 200, body } = typeof route === "function" ? route(call) : route;
    return reply(body, status);
  };
  return { fetch, calls };
}

/** Build settlement records the way the INFERVA app does, hashed with node:crypto (independent of src/chain.ts). */
export function buildChain(n: number, genesis = GENESIS) {
  const records = [];
  let prev = genesis;
  for (let i = 1; i <= n; i++) {
    const r = {
      seq: i,
      id: `req_${String(i).padStart(4, "0")}`,
      key_id: "key_a",
      payer: "0x000000000000000000000000000000000000beef",
      provider: "prv_basalt",
      provider_name: "Basalt Inference",
      model: "basalt-70b",
      tokens: 100 * i,
      base: 180 * i,
      discount: 0,
      fee: 18 * i,
      // Legacy column, 0 on current records. The fee splits between the sponsor (80% in this data) and the treasury.
      to_stakers: 0,
      to_sponsor: Math.floor((18 * i * 8000) / 10_000),
      to_treasury: 18 * i - Math.floor((18 * i * 8000) / 10_000),
      capacity_id: "cap_1",
      priority: 0,
      epoch: 500000,
      created_at: 1_794_000_000_000 + i * 1000,
      prev_hash: prev,
      hash: "",
    };
    const payload = [prev, r.id, r.payer, r.provider, r.model, r.tokens, r.base, r.discount, r.fee, r.capacity_id, r.epoch, r.created_at].join("|");
    r.hash = createHash("sha256").update(payload).digest("hex");
    prev = r.hash;
    records.push(r);
  }
  return records;
}

/** Serve records from GET /api/chain with after/limit paging like the app. */
export function chainRoute(records: { seq: number }[], genesis = GENESIS): Route {
  return ({ url }) => {
    const after = Number(url.searchParams.get("after")) || 0;
    const limit = Number(url.searchParams.get("limit")) || 200;
    return { body: { genesis, records: records.filter((r) => r.seq > after).slice(0, limit) } };
  };
}

/** An MCP client connected in-memory to the inferva server, backed by the fetch stub. */
export async function connect(routes: Record<string, Route>, apiKey?: string) {
  const { fetch, calls } = mockFetch(routes);
  const server = createInfervaServer({ client: new InfervaClient({ baseUrl: BASE, apiKey, fetch }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: !!res.isError, text, json };
  }
  return { client, calls, call };
}

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BASE, GENESIS, buildChain, chainRoute, connect } from "./helpers.js";

const KEY = "inf_sk_" + "x".repeat(24);

const completion = {
  id: "req_abc",
  object: "chat.completion",
  created: 1794000000,
  model: "basalt-70b",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello from INFERVA" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  inferva: {
    provider: "Basalt Inference",
    priority: false,
    tier: "No tier",
    cost_usdc: 0.000034,
    breakdown: { provider_cost: 0.000031, discount: 0, protocol_fee: 0.000003, to_stakers: 0.000001, to_sponsor: 0.000001, to_treasury: 0.000001 },
    capacity: "cap_1",
    epoch: 500000,
    settlement: { hash: "b".repeat(64), prev_hash: "a".repeat(64) },
    receipt: `${BASE}/receipt/req_abc`,
  },
};

describe("tool list", () => {
  it("registers every tool, only chat is not read-only", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "chat",
        "get_capacity_market",
        "get_leaderboard",
        "get_model_catalog",
        "get_network",
        "get_params",
        "get_proposal",
        "get_provider",
        "get_receipt",
        "get_stats",
        "list_epochs",
        "list_models",
        "list_proposals",
        "list_providers",
        "list_requests",
        "list_slashes",
        "verify_settlement_chain",
      ].sort(),
    );
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(t.name !== "chat");
  });
});

describe("chat", () => {
  it("posts to /v1/chat/completions with the key and returns cost, breakdown and receipt", async () => {
    const { call, calls } = await connect({ "POST /v1/chat/completions": { body: completion } }, KEY);
    const res = await call("chat", { prompt: "hi", model: "basalt-70b", max_tokens: 64 });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({
      id: "req_abc",
      content: "Hello from INFERVA",
      cost_usdc: 0.000034,
      breakdown: { protocol_fee: 0.000003 },
      provider: "Basalt Inference",
      receipt: `${BASE}/receipt/req_abc`,
      settlement: { hash: "b".repeat(64) },
    });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toEqual({ model: "basalt-70b", messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: false });
  });

  it("defaults the model to auto and forwards messages", async () => {
    const { call, calls } = await connect({ "POST /v1/chat/completions": { body: completion } }, KEY);
    await call("chat", { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] });
    expect(calls[0]!.body).toMatchObject({ model: "auto", messages: [{ content: "a" }, { content: "b" }, { content: "c" }] });
  });

  it("fails without INFERVA_API_KEY and makes no request", async () => {
    const { call, calls } = await connect({ "POST /v1/chat/completions": { body: completion } });
    const res = await call("chat", { prompt: "hi" });
    expect(res.isError).toBe(true);
    expect(res.json.error).toBe("missing_api_key");
    expect(calls).toHaveLength(0);
  });

  it("needs prompt or messages", async () => {
    const { call } = await connect({}, KEY);
    const res = await call("chat", {});
    expect(res.json.error).toBe("invalid_input");
  });

  it.each([
    [402, "insufficient_funds"],
    [402, "spend_cap_reached"],
    [401, "invalid_api_key"],
    [404, "model_not_found"],
    [429, "rate_limit_exceeded"],
    [429, "congestion_deferred"],
    [503, "capacity_exhausted"],
    [502, "provider_error"],
  ])("passes endpoint error %i %s through with a hint", async (status, type) => {
    const { call } = await connect({ "POST /v1/chat/completions": { status, body: { error: { message: `server says ${type}`, type } } } }, KEY);
    const res = await call("chat", { prompt: "hi" });
    expect(res.isError).toBe(true);
    expect(res.json).toMatchObject({ error: type, status, message: `server says ${type}` });
    expect(typeof res.json.hint).toBe("string");
  });
});

describe("read tools", () => {
  it("list_models", async () => {
    const { call } = await connect({
      "GET /v1/models": {
        body: {
          object: "list",
          data: [
            { id: "auto", object: "model", owned_by: "inferva", description: "Routes to the cheapest active provider" },
            { id: "basalt-70b", object: "model", owned_by: "Basalt Inference", price_per_1k_usdc: 0.0018 },
          ],
        },
      },
    });
    const res = await call("list_models");
    expect(res.json.count).toBe(2);
    expect(res.json.models[1]).toEqual({ id: "basalt-70b", provider: "Basalt Inference", price_per_1k_usdc: 0.0018 });
  });

  it("get_stats converts micro units", async () => {
    const { call } = await connect({
      "GET /api/stats": {
        body: {
          volume: 381,
          fees: 35,
          requests: 1,
          treasury: 21,
          totalStaked: 5_000_000_000,
          stakers: 2,
          capacityTotal: 1_100_000_000,
          capacityRemaining: 1_099_999_654,
          sponsors: 2,
          providers: 3,
          epoch: 10,
          epochEndsAt: 1_794_225_600_000,
          epochFees: 0,
          epochRequests: 0,
          series: [{ epoch: 10, fees: 35, volume: 381, requests: 1 }],
        },
      },
    });
    const res = await call("get_stats");
    expect(res.json).toMatchObject({ volume_usdc: 0.000381, fees_usdc: 0.000035, staked_infer: 5000, capacity_total_usdc: 1100, active_providers: 3, epoch: { number: 10, ends_at: "2026-11-09T12:00:00.000Z" } });
    expect(res.json.series[0]).toEqual({ epoch: 10, requests: 1, volume_usdc: 0.000381, fees_usdc: 0.000035 });
  });

  it("get_params formats values", async () => {
    const { call } = await connect({
      "GET /api/params": {
        body: {
          params: { fee_bps: 1000, tier1_stake: 1_000_000_000, epoch_seconds: 3600, unstake_cooldown_seconds: 3600 },
          info: {
            fee_bps: { label: "Protocol fee on provider cost", kind: "bps", governable: true },
            tier1_stake: { label: "Tier 1 stake", kind: "amount", governable: true },
            epoch_seconds: { label: "Epoch length", kind: "seconds", governable: true },
          },
        },
      },
    });
    const res = await call("get_params");
    const by = Object.fromEntries(res.json.params.map((p: any) => [p.name, p]));
    expect(by.fee_bps.display).toBe("10%");
    expect(by.tier1_stake.display).toBe("1000 INFER");
    expect(by.epoch_seconds).toMatchObject({ display: "3600s", governable: true });
    expect(by.unstake_cooldown_seconds).toMatchObject({ kind: "seconds", governable: false });
  });

  it("list_requests passes limit and adds receipts", async () => {
    const records = buildChain(2).reverse();
    const { call, calls } = await connect({ "GET /api/requests": { body: records } });
    const res = await call("list_requests", { limit: 2 });
    expect(calls[0]!.url.searchParams.get("limit")).toBe("2");
    expect(calls[0]!.url.searchParams.has("mine")).toBe(false);
    expect(res.json.requests[0]).toMatchObject({ seq: 2, cost_usdc: (360 + 36) / 1e6, receipt: `${BASE}/receipt/req_0002`, priority: false });
  });

  it("get_receipt verifies the record and its links", async () => {
    const [a, b, c] = buildChain(3);
    const { call } = await connect({
      "GET /api/receipts/req_0002": { body: { record: b, prev: { seq: 1, id: a!.id, hash: a!.hash }, next: { seq: 3, id: c!.id, prev_hash: c!.prev_hash }, genesis: GENESIS } },
    });
    const res = await call("get_receipt", { id: "req_0002" });
    expect(res.json).toMatchObject({ id: "req_0002", verified: true, check: { hash_matches_contents: true, links_to_previous: true, next_links_here: true } });
  });

  it("get_receipt flags a tampered record", async () => {
    const [a] = buildChain(1);
    const { call } = await connect({ "GET /api/receipts/req_0001": { body: { record: { ...a, tokens: 1 }, prev: null, next: null, genesis: GENESIS } } });
    const res = await call("get_receipt", { id: "req_0001" });
    expect(res.json).toMatchObject({ verified: false, previous: { genesis: GENESIS }, check: { hash_matches_contents: false, links_to_previous: true, next_links_here: null } });
  });

  it("get_receipt 404 is an error result", async () => {
    const { call } = await connect({ "GET /api/receipts/req_missing": { status: 404, body: { error: "Receipt not found" } } });
    const res = await call("get_receipt", { id: "req_missing" });
    expect(res.isError).toBe(true);
    expect(res.json).toMatchObject({ error: "not_found", status: 404, message: "Receipt not found" });
  });

  it("verify_settlement_chain checks every record and reports a broken one", async () => {
    const records = buildChain(3);
    const ok = await connect({ "GET /api/chain": chainRoute(records) });
    expect((await ok.call("verify_settlement_chain")).json).toMatchObject({ checked: 3, intact: true, firstBroken: null });

    records[2]!.base = 1;
    const bad = await connect({ "GET /api/chain": chainRoute(records) });
    expect((await bad.call("verify_settlement_chain")).json).toMatchObject({ checked: 2, intact: false, firstBroken: { seq: 3, reason: "hash_mismatch" } });
  });

  it("providers, governance, network, epochs, leaderboard, market hit their routes", async () => {
    const provider = { id: "prv_basalt", name: "Basalt Inference", operator: "genesis", website: "", status: "active", bond: 12_000_000_000, slashed: 0, weight: 100, requests: 1, tokens: 192, routable: true, created_at: 0, model_prices: [{ model: "basalt-70b", price_in: 1_800_000, price_out: 1_800_000 }] };
    const { call, calls } = await connect({
      "GET /api/providers": { body: [provider] },
      "GET /api/providers/prv_basalt": { body: { ...provider, refunded: 0, unbond_at: null, operatorStake: null, notRoutable: null, billed: 346, successRate: null, attempts: 0, uptime: 1, epochs: [], slashes: [], events: [], recent: [] } },
      "GET /api/slashes": { body: { treasuryInfer: 0, slashes: [] } },
      "GET /api/proposals": { body: [{ id: 1, status: "open", ends_at: 1, created_at: 1, voted: null }, { id: 2, status: "passed", ends_at: 1, created_at: 1 }] },
      "GET /api/proposals/1": { body: { id: 1, status: "open", ends_at: 1, created_at: 1, votes: [], me: null } },
      "GET /api/network": { body: { capacity: 600, congested: false } },
      "GET /api/earn/epochs": { body: { epoch: 2, epochSeconds: 3600, endsAt: 1, rows: [{ epoch: 2, starts_at: 1, ends_at: 2, requests: 0, tokens: 0, volume: 0, fees: 0, to_stakers: 0, to_sponsor: 0, to_treasury: 0 }], hasMore: false } },
      "GET /api/earn/leaderboard": { body: { stakers: [], sponsors: [], providers: [], me: { staker: null, sponsor: null }, totalStaked: 0 } },
      "GET /api/market": { body: { open: [], mine: [], sales: [] } },
      "GET /api/agents/catalog": { body: { models: [{ id: "basalt-70b", provider_id: "prv_basalt", provider: "Basalt Inference", price_1m: 1_800_000, your_price_1m: 1_980_000, requests: 0, tokens: 0, avg_latency_ms: null, attempts: 0, success_rate: null, cheapest: true, last_used: null }], tier: { name: "No tier", discountBps: 0 }, fee_bps: 1000, limits: { maxMessages: 20 }, window_days: 30 } },
    });
    expect((await call("list_providers")).json.providers[0]).toMatchObject({ bond_infer: 12000, models: [{ model: "basalt-70b", input_usdc_per_1m: 1.8 }] });
    expect((await call("get_provider", { id: "prv_basalt" })).json).toMatchObject({ billed_usdc: 0.000346, uptime: 1 });
    expect((await call("list_slashes")).json).toMatchObject({ treasury_infer: 0, count: 0 });
    const props = (await call("list_proposals", { status: "open" })).json;
    expect(props.count).toBe(1);
    expect(props.proposals[0]).not.toHaveProperty("voted");
    expect((await call("get_proposal", { id: 1 })).json).not.toHaveProperty("me");
    expect((await call("get_network")).json).toEqual({ capacity: 600, congested: false });
    expect((await call("list_epochs", { limit: 5 })).json.epochs).toHaveLength(1);
    expect((await call("get_leaderboard")).json).not.toHaveProperty("me");
    expect((await call("get_capacity_market")).json).not.toHaveProperty("mine");
    expect((await call("get_model_catalog")).json.models[0]).toMatchObject({ list_usdc_per_1m: 1.8, all_in_usdc_per_1m: 1.98, auto_routes_here: true });
    expect(calls.find((c) => c.url.pathname === "/api/earn/epochs")!.url.searchParams.get("limit")).toBe("5");
    // Read tools never send a key.
    for (const c of calls) expect(c.headers.authorization).toBeUndefined();
  });

  it("network failures become error results", async () => {
    const { call } = await connect({ "GET /api/stats": { status: 500, body: { error: "Something went wrong" } } });
    const res = await call("get_stats");
    expect(res.json).toMatchObject({ error: "server_error", status: 500 });
  });
});

describe("config", () => {
  it("defaults to the live app and reads the key", () => {
    expect(loadConfig({})).toEqual({ baseUrl: "https://dapp.inferva.xyz", apiKey: undefined, timeoutMs: 60_000 });
    expect(loadConfig({ INFERVA_BASE_URL: "http://localhost:3252/", INFERVA_API_KEY: KEY, INFERVA_TIMEOUT_MS: "5000" })).toEqual({ baseUrl: "http://localhost:3252", apiKey: KEY, timeoutMs: 5000 });
    expect(() => loadConfig({ INFERVA_BASE_URL: "ftp://x" })).toThrow();
  });
});

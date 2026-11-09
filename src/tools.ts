import { z } from "zod";
import { sha256Hex, settlementPayload, verifyChain, type SettlementRecord } from "./chain.js";
import type { InfervaClient } from "./client.js";

export type ToolContext = { client: InfervaClient };

export type ToolDef<S extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  /** Spends the key owner's USDG (only `chat`). Everything else is a public read. */
  paid?: boolean;
  /** Route(s) on the INFERVA API this tool calls. */
  route: string;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
};

const defineTool = <S extends z.ZodRawShape>(def: ToolDef<S>) => def;

/** Amounts on the API are integers in micro units: 1 USDG (or 1 INFER) = 1,000,000. */
export const UNIT = 1_000_000;
const units = (n: number | null | undefined) => (typeof n === "number" ? n / UNIT : null);
const iso = (ms: number | null | undefined) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);
const RAW_UNITS = "Amounts are integers in micro units: 1 USDG or 1 INFER = 1,000,000.";

const limit = (def: number, max: number) =>
  z.number().int().min(1).max(max).optional().describe(`Max rows to return (default ${def}, max ${max}).`);
const id = (what: string, example: string) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/, "letters, digits, '_', '.', '-'")
    .describe(`${what}, e.g. ${example}`);

type RequestRow = SettlementRecord & {
  key_id?: string;
  provider_name?: string | null;
  to_sponsor: number;
  to_treasury: number;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  latency_ms?: number | null;
  stream?: number | null;
};

/**
 * A settlement record in USDG with readable times. Hash fields are kept as-is so they can be re-checked.
 * `discount` is hashed and is 0 on current records, so it only counts toward the cost of older records.
 */
function requestView(r: RequestRow, baseUrl: string) {
  return {
    seq: r.seq,
    id: r.id,
    payer: r.payer,
    provider: r.provider,
    provider_name: r.provider_name ?? null,
    model: r.model,
    tokens: r.tokens,
    ...(r.prompt_tokens != null ? { prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens } : {}),
    ...(r.latency_ms != null ? { latency_ms: r.latency_ms } : {}),
    cost_usdg: units(r.base - r.discount + r.fee),
    breakdown: {
      provider_cost: units(r.base),
      protocol_fee: units(r.fee),
      to_sponsor: units(r.to_sponsor),
      to_treasury: units(r.to_treasury),
    },
    capacity_id: r.capacity_id,
    epoch: r.epoch,
    created_at: iso(r.created_at),
    settlement: { prev_hash: r.prev_hash, hash: r.hash },
    receipt: `${baseUrl}/receipt/${r.id}`,
  };
}

type ProviderSummary = {
  id: string;
  name: string;
  operator: string;
  website: string;
  status: string;
  bond: number;
  slashed: number;
  weight: number;
  requests: number;
  tokens: number;
  routable: boolean;
  created_at: number;
  model_prices?: { model: string; price_in: number; price_out: number }[];
};

function providerView(p: ProviderSummary) {
  return {
    id: p.id,
    name: p.name,
    operator: p.operator,
    website: p.website || null,
    status: p.status,
    routable: p.routable,
    routing_weight: p.weight,
    bond_infer: units(p.bond),
    slashed_infer: units(p.slashed),
    requests: p.requests,
    tokens: p.tokens,
    models: (p.model_prices ?? []).map((m) => ({ model: m.model, input_usdg_per_1m: units(m.price_in), output_usdg_per_1m: units(m.price_out) })),
    created_at: iso(p.created_at),
  };
}

const message = z.object({
  role: z.enum(["system", "user", "assistant"]).describe("Who said it. system is sent as a user turn."),
  content: z.string().min(1).max(8_000),
});

export const TOOLS = [
  defineTool({
    name: "list_models",
    title: "List models",
    route: "GET /v1/models",
    description:
      'Every model an active INFERVA provider serves, with the provider and its list price in USDG per 1k tokens. "auto" routes each request to the cheapest active provider. Use a model id from here as `model` in chat.',
    inputSchema: {},
    async run(_args, { client }) {
      const res = await client.get<{ data: { id: string; owned_by: string; description?: string; price_per_1k_usdg?: number }[] }>("/v1/models");
      return {
        count: res.data.length,
        models: res.data.map((m) => ({ id: m.id, provider: m.owned_by, price_per_1k_usdg: m.price_per_1k_usdg ?? null, ...(m.description ? { description: m.description } : {}) })),
      };
    },
  }),
  defineTool({
    name: "get_model_catalog",
    title: "Model catalog",
    route: "GET /api/agents/catalog",
    description:
      "Model catalog with usage over the recent window: per model and provider the list price and the all-in price (list price plus protocol fee, the same for every account) in USDG per 1M tokens, request and token counts, average latency, routing success rate, and which model auto routes to. Also returns the endpoint limits (messages, characters per message, max output tokens).",
    inputSchema: {},
    async run(_args, { client }) {
      const res = await client.get<{
        models: { id: string; provider_id: string; provider: string; price_1m: number; your_price_1m: number; requests: number; tokens: number; avg_latency_ms: number | null; success_rate: number | null; cheapest: boolean; last_used: number | null }[];
        fee_bps: number;
        limits: unknown;
        window_days: number;
      }>("/api/agents/catalog");
      return {
        window_days: res.window_days,
        protocol_fee_bps: res.fee_bps,
        limits: res.limits,
        models: res.models.map((m) => ({
          id: m.id,
          provider_id: m.provider_id,
          provider: m.provider,
          list_usdg_per_1m: units(m.price_1m),
          all_in_usdg_per_1m: units(m.your_price_1m),
          requests: m.requests,
          tokens: m.tokens,
          avg_latency_ms: m.avg_latency_ms,
          success_rate: m.success_rate,
          auto_routes_here: m.cheapest,
          last_used: iso(m.last_used),
        })),
      };
    },
  }),
  defineTool({
    name: "chat",
    title: "Chat completion (paid)",
    route: "POST /v1/chat/completions",
    paid: true,
    description:
      "Send a chat completion through INFERVA's one endpoint. Requires INFERVA_API_KEY (an inf_sk_... agent key). The request is routed to a provider, metered, charged in USDG to the key owner's balance and written to the settlement log. Returns the reply plus cost_usdg, the fee breakdown (provider cost, protocol fee and its split between the capacity sponsor and the treasury), the settlement hash and a public receipt URL. Pass either `prompt` or `messages`.",
    inputSchema: {
      prompt: z.string().min(1).max(8_000).optional().describe("A single user message. Shortcut for messages: [{ role: 'user', content: prompt }]."),
      messages: z.array(message).min(1).max(20).optional().describe("Conversation, oldest first (the endpoint keeps the last 20)."),
      model: z.string().trim().min(1).max(64).optional().describe('Model id from list_models. Default "auto" (cheapest active provider).'),
      max_tokens: z.number().int().min(1).max(1024).optional().describe("Output token limit (max 1024)."),
    },
    async run(args, { client }) {
      const messages = args.messages ?? (args.prompt ? [{ role: "user" as const, content: args.prompt }] : null);
      if (!messages) throw new InputError("Pass `prompt` or `messages`.");
      const res = await client.chat<{
        id: string;
        model: string;
        choices: { message: { content: string }; finish_reason: string }[];
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        inferva?: { provider: string; cost_usdg: number; breakdown: Record<string, number>; capacity: string; epoch: number; settlement: { hash: string; prev_hash: string }; receipt: string };
      }>({ model: args.model ?? "auto", messages, ...(args.max_tokens ? { max_tokens: args.max_tokens } : {}), stream: false });
      const inf = res.inferva;
      return {
        id: res.id,
        model: res.model,
        content: res.choices[0]?.message.content ?? "",
        finish_reason: res.choices[0]?.finish_reason ?? null,
        usage: res.usage,
        provider: inf?.provider ?? null,
        cost_usdg: inf?.cost_usdg ?? null,
        breakdown: inf?.breakdown ?? null,
        capacity: inf?.capacity ?? null,
        epoch: inf?.epoch ?? null,
        settlement: inf?.settlement ?? null,
        receipt: inf?.receipt ?? null,
      };
    },
  }),
  defineTool({
    name: "get_stats",
    title: "Network stats",
    route: "GET /api/stats",
    description:
      "Protocol totals: settled requests, volume and fees in USDG, the fee shares paid to the treasury and to capacity sponsors, sponsored capacity (total and remaining, USDG) and sponsor count, active providers, the current epoch with its fees and requests, and the last 24 epochs as a series.",
    inputSchema: {},
    async run(_args, { client }) {
      const s = await client.get<{
        volume: number;
        fees: number;
        requests: number;
        treasury: number;
        sponsorFees: number;
        capacityTotal: number;
        capacityRemaining: number;
        sponsors: number;
        providers: number;
        epoch: number;
        epochEndsAt: number;
        epochFees: number;
        epochRequests: number;
        series: { epoch: number; fees: number; volume: number; requests: number }[];
      }>("/api/stats");
      return {
        requests: s.requests,
        volume_usdg: units(s.volume),
        fees_usdg: units(s.fees),
        treasury_usdg: units(s.treasury),
        sponsor_fees_usdg: units(s.sponsorFees),
        capacity_total_usdg: units(s.capacityTotal),
        capacity_remaining_usdg: units(s.capacityRemaining),
        sponsors: s.sponsors,
        active_providers: s.providers,
        epoch: { number: s.epoch, ends_at: iso(s.epochEndsAt), fees_usdg: units(s.epochFees), requests: s.epochRequests },
        series: s.series.map((e) => ({ epoch: e.epoch, requests: e.requests, volume_usdg: units(e.volume), fees_usdg: units(e.fees) })),
      };
    },
  }),
  defineTool({
    name: "get_params",
    title: "Protocol parameters",
    route: "GET /api/params",
    description:
      "Current protocol parameters (protocol fee rate, the capacity sponsor share of the fee (the treasury takes the rest), epoch length, provider bond, voting window, quorum, INFER needed to open a proposal, gateway capacity), each with a readable value and whether governance can change it. These are live values and can change through governance.",
    inputSchema: {},
    async run(_args, { client }) {
      const res = await client.get<{ params: Record<string, number>; info: Record<string, { label: string; kind: string; governable: boolean }> }>("/api/params");
      return {
        params: Object.entries(res.params).map(([name, value]) => {
          const info = res.info[name];
          const kind = info?.kind ?? (name.endsWith("_seconds") ? "seconds" : name.endsWith("_bps") ? "bps" : "count");
          const display = kind === "bps" ? `${value / 100}%` : kind === "amount" ? `${value / UNIT} INFER` : kind === "seconds" ? `${value}s` : String(value);
          return { name, label: info?.label ?? name, value, display, kind, governable: info?.governable ?? false };
        }),
      };
    },
  }),
  defineTool({
    name: "list_requests",
    title: "Recent settled requests",
    route: "GET /api/requests",
    description:
      "Most recent settled requests from the public settlement log, newest first: payer, provider, model, tokens, cost in USDG with the fee split between sponsor and treasury, capacity position drawn, epoch, the chained hashes and a receipt URL.",
    inputSchema: { limit: limit(20, 200) },
    async run(args, { client }) {
      const rows = await client.get<RequestRow[]>("/api/requests", { limit: args.limit ?? 20 });
      return { count: rows.length, requests: rows.map((r) => requestView(r, client.baseUrl)) };
    },
  }),
  defineTool({
    name: "get_receipt",
    title: "Request receipt",
    route: "GET /api/receipts/:id",
    description:
      "Public receipt for one settled request (id like req_...), as returned by chat. Includes the full cost breakdown and checks the record locally: its hash is recomputed from its contents, and its link to the previous record (or the genesis value) and from the next record are verified.",
    inputSchema: { id: id("Request id", "req_b3554939b912de693875") },
    async run(args, { client }) {
      const r = await client.get<{
        record: RequestRow;
        prev: { seq: number; id: string; hash: string } | null;
        next: { seq: number; id: string; prev_hash: string } | null;
        genesis: string;
      }>(`/api/receipts/${encodeURIComponent(args.id)}`);
      const expectedPrev = r.prev ? r.prev.hash : r.genesis;
      const recomputed = await sha256Hex(settlementPayload(r.record, r.record.prev_hash));
      const check = {
        hash_matches_contents: recomputed === r.record.hash,
        links_to_previous: r.record.prev_hash === expectedPrev,
        next_links_here: r.next ? r.next.prev_hash === r.record.hash : null,
        recomputed_hash: recomputed,
      };
      return {
        ...requestView(r.record, client.baseUrl),
        previous: r.prev ? { seq: r.prev.seq, id: r.prev.id } : { genesis: r.genesis },
        next: r.next ? { seq: r.next.seq, id: r.next.id } : null,
        verified: check.hash_matches_contents && check.links_to_previous && check.next_links_here !== false,
        check,
      };
    },
  }),
  defineTool({
    name: "verify_settlement_chain",
    title: "Verify the settlement chain",
    route: "GET /api/chain (paged)",
    description:
      "Download the settlement log in order from the genesis value and recompute every SHA-256 hash locally, exactly as the INFERVA app does. Nothing trusts the server's hash column. Reports how many records were checked, whether the chain is intact, and the first broken record (wrong link or hash that does not match its contents) if any.",
    inputSchema: {
      max_records: z.number().int().min(1).max(1_000_000).optional().describe("Stop after this many records (default: the whole chain)."),
    },
    async run(args, { client }) {
      return verifyChain(client, { maxRecords: args.max_records });
    },
  }),
  defineTool({
    name: "list_providers",
    title: "Providers",
    route: "GET /api/providers",
    description:
      "Inference providers on INFERVA: status, whether they are routable, routing weight, INFER bond and amount slashed, requests and tokens served, and per-model input/output prices in USDG per 1M tokens.",
    inputSchema: {},
    async run(_args, { client }) {
      const rows = await client.get<ProviderSummary[]>("/api/providers");
      return { count: rows.length, providers: rows.map(providerView) };
    },
  }),
  defineTool({
    name: "get_provider",
    title: "Provider detail",
    route: "GET /api/providers/:id",
    description:
      "One provider in detail: everything in list_providers plus USDG billed, success rate on real calls, uptime, why it is not routable (if so), slashes, lifecycle events, the last 24 epochs and its most recent requests.",
    inputSchema: { id: id("Provider id", "prv_basalt") },
    async run(args, { client }) {
      const d = await client.get<
        ProviderSummary & {
          refunded: number;
          unbond_at: number | null;
          notRoutable: string | null;
          billed: number;
          successRate: number | null;
          attempts: number;
          uptime: number;
          epochs: { epoch: number; requests: number; tokens: number; billed: number }[];
          slashes: unknown[];
          events: unknown[];
          recent: { id: string; model: string; tokens: number; base: number; epoch: number; created_at: number }[];
        }
      >(`/api/providers/${encodeURIComponent(args.id)}`);
      return {
        ...providerView(d),
        not_routable_reason: d.notRoutable,
        refunded_infer: units(d.refunded),
        unbond_at: iso(d.unbond_at),
        billed_usdg: units(d.billed),
        success_rate: d.successRate,
        attempts: d.attempts,
        uptime: d.uptime,
        epochs: d.epochs.map((e) => ({ epoch: e.epoch, requests: e.requests, tokens: e.tokens, billed_usdg: units(e.billed) })),
        recent: d.recent.map((r) => ({ id: r.id, model: r.model, tokens: r.tokens, provider_cost_usdg: units(r.base), epoch: r.epoch, created_at: iso(r.created_at) })),
        slashes: d.slashes,
        events: d.events,
        units: RAW_UNITS,
      };
    },
  }),
  defineTool({
    name: "list_slashes",
    title: "Slashes",
    route: "GET /api/slashes",
    description: "Every executed provider slash, newest first, and the INFER the treasury holds from slashing.",
    inputSchema: {},
    async run(_args, { client }) {
      const res = await client.get<{ treasuryInfer: number; slashes: unknown[] }>("/api/slashes");
      return { treasury_infer: units(res.treasuryInfer), count: res.slashes.length, slashes: res.slashes, units: RAW_UNITS };
    },
  }),
  defineTool({
    name: "list_proposals",
    title: "Governance proposals",
    route: "GET /api/proposals",
    description:
      "Governance proposals, newest first (up to 100): parameter changes, provider slashes and routing-weight changes, with yes/no totals weighted by INFER held, quorum, status and voting deadline.",
    inputSchema: {
      status: z.enum(["open", "passed", "rejected", "executed", "failed"]).optional().describe("Only proposals with this status."),
    },
    async run(args, { client }) {
      const rows = await client.get<{ status: string; ends_at: number; created_at: number; voted?: unknown }[]>("/api/proposals");
      const list = rows.filter((p) => !args.status || p.status === args.status).map(({ voted: _voted, ...p }) => ({ ...p, ends_at: iso(p.ends_at), created_at: iso(p.created_at) }));
      return { count: list.length, proposals: list, units: `${RAW_UNITS} yes, no and quorum are voting weight: INFER held, plus INFER delegated to the voter.` };
    },
  }),
  defineTool({
    name: "get_proposal",
    title: "Governance proposal",
    route: "GET /api/proposals/:id",
    description: "One governance proposal with every vote (address, side, weight, delegate used) and the current value of what it would change.",
    inputSchema: { id: z.number().int().min(1).describe("Proposal number.") },
    async run(args, { client }) {
      const { me: _me, voted: _voted, ...p } = await client.get<Record<string, unknown> & { ends_at: number; created_at: number }>(`/api/proposals/${args.id}`);
      return { ...p, ends_at: iso(p.ends_at), created_at: iso(p.created_at), units: `${RAW_UNITS} yes, no, quorum and vote weights are voting weight: INFER held, plus INFER delegated to the voter.` };
    },
  }),
  defineTool({
    name: "get_network",
    title: "Network load",
    route: "GET /api/network",
    description:
      "Live gateway load: requests admitted in the last minute against capacity, whether the network is congested (every caller shares the same lane; above capacity requests are deferred with a 429), admitted and deferred counts, the last 30 minutes, and active/routable provider counts.",
    inputSchema: {},
    async run(_args, { client }) {
      return client.get("/api/network");
    },
  }),
  defineTool({
    name: "list_epochs",
    title: "Epochs",
    route: "GET /api/earn/epochs",
    description: "Fee epochs, newest first: requests, tokens, volume, fees and how fees split between capacity sponsors and the treasury per epoch.",
    inputSchema: { limit: limit(30, 60) },
    async run(args, { client }) {
      const res = await client.get<{ epoch: number; epochSeconds: number; endsAt: number; rows: Record<string, number>[]; hasMore: boolean }>("/api/earn/epochs", { limit: args.limit ?? 30 });
      return {
        current_epoch: res.epoch,
        epoch_seconds: res.epochSeconds,
        current_ends_at: iso(res.endsAt),
        has_more: res.hasMore,
        epochs: res.rows.map((r) => ({
          epoch: r.epoch,
          starts_at: iso(r.starts_at),
          ends_at: iso(r.ends_at),
          requests: r.requests,
          tokens: r.tokens,
          volume_usdg: units(r.volume),
          fees_usdg: units(r.fees),
          to_sponsor_usdg: units(r.to_sponsor),
          to_treasury_usdg: units(r.to_treasury),
        })),
      };
    },
  }),
  defineTool({
    name: "get_leaderboard",
    title: "Leaderboards",
    route: "GET /api/earn/leaderboard",
    description: "Top capacity sponsors (USDG earned, live capacity, draws) and top providers by volume.",
    inputSchema: {},
    async run(_args, { client }) {
      const { me: _me, ...rest } = await client.get<Record<string, unknown>>("/api/earn/leaderboard");
      return { ...rest, units: `${RAW_UNITS} Sponsor value = USDG earned, extra = USDG capacity left, extra2 = draws. Provider volume = USDG.` };
    },
  }),
  defineTool({
    name: "get_capacity_market",
    title: "Capacity market",
    route: "GET /api/market",
    description: "Open listings of sponsored capacity positions for sale and recent sales, with each position's deposit, remaining capacity, amount drawn and earnings.",
    inputSchema: {},
    async run(_args, { client }) {
      const res = await client.get<{ open: unknown[]; sales: unknown[] }>("/api/market");
      return { open: res.open, sales: res.sales, units: RAW_UNITS };
    },
  }),
];

/** Invalid tool input that the schema cannot express. */
export class InputError extends Error {
  override name = "InputError";
}

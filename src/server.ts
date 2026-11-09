import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InfervaApiError, InfervaClient } from "./client.js";
import { VERSION, loadConfig } from "./config.js";
import { InputError, TOOLS, type ToolContext } from "./tools.js";

export type ServerOptions = { client?: InfervaClient; log?: (msg: string) => void };

/** What to do about each error the endpoint can answer. The endpoint's own message is passed through as well. */
const HINTS: Record<string, string> = {
  missing_api_key: "Set INFERVA_API_KEY to an agent key (inf_sk_...). Create one in the app under Endpoint & keys.",
  invalid_api_key: "The agent key is unknown or revoked. Create a new one in the app under Endpoint & keys.",
  insufficient_funds: "The key owner's USDG balance does not cover this request.",
  spend_cap_reached: "This key reached its monthly spend cap. Raise it in the app or wait for the reset.",
  model_not_allowed: "This key is restricted to certain models. Use one it allows, or \"auto\".",
  model_not_found: "No active provider serves that model. Call list_models.",
  rate_limit_exceeded: "Per-minute rate limit per account (the same for everyone). Wait a minute and retry.",
  congestion_deferred: "The network is at capacity and the request was deferred. Retry shortly.",
  capacity_exhausted: "No sponsored capacity has room for this request right now.",
  provider_error: "The provider could not complete the request. Nothing was charged.",
  settlement_busy: "Settlement was busy. Retry.",
  invalid_request_error: "The request body was rejected.",
  not_found: "Not found on the INFERVA API.",
  timeout: "The INFERVA API did not answer in time. Try again.",
  network_error: "Could not reach the INFERVA API. Check INFERVA_BASE_URL and the network.",
};

export function errorResult(err: unknown): CallToolResult {
  let body: Record<string, unknown>;
  if (err instanceof InfervaApiError) body = { error: err.code, status: err.status, message: err.message, ...(HINTS[err.code] ? { hint: HINTS[err.code] } : {}) };
  else if (err instanceof InputError) body = { error: "invalid_input", message: err.message };
  else body = { error: "internal_error", message: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}

export function okResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** Build the `inferva` MCP server with every tool registered. Transport-agnostic. */
export function createInfervaServer(opts: ServerOptions = {}): McpServer {
  const client =
    opts.client ??
    (() => {
      const c = loadConfig();
      return new InfervaClient({ baseUrl: c.baseUrl, apiKey: c.apiKey, timeoutMs: c.timeoutMs });
    })();
  const ctx: ToolContext = { client };
  const log = opts.log ?? (() => {});

  const server = new McpServer(
    { name: "inferva", version: VERSION },
    {
      instructions:
        "INFERVA is one inference endpoint AI agents pay through. `chat` sends a paid completion (needs INFERVA_API_KEY) and returns the reply with its USDG cost, fee split and receipt. Every other tool is a free public read: models, network stats, protocol parameters, the settlement log (with local hash-chain verification), providers, governance, epochs and the capacity market.",
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: !tool.paid,
          destructiveHint: false,
          idempotentHint: !tool.paid,
          openWorldHint: true,
        },
      },
      async (args: unknown) => {
        try {
          const data = await (tool.run as (a: unknown, c: ToolContext) => Promise<unknown>)(args, ctx);
          return okResult(data);
        } catch (err) {
          log(`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`);
          return errorResult(err);
        }
      },
    );
  }
  return server;
}

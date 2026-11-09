#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InfervaClient } from "./client.js";
import { VERSION, loadConfig } from "./config.js";
import { createInfervaServer } from "./server.js";

const HELP = `inferva-mcp ${VERSION} - MCP server for INFERVA (stdio)

Usage:
  inferva-mcp              run on stdio (for Claude Desktop, Claude Code, Cursor, ...)
  inferva-mcp --help | --version

Environment:
  INFERVA_API_KEY     agent key (inf_sk_...), only needed for the chat tool
  INFERVA_BASE_URL    app and endpoint origin (default https://dapp.inferva.xyz)
  INFERVA_TIMEOUT_MS  per-request timeout (default 60000)
  INFERVA_DEBUG=1     log tool errors to stderr
`;

async function main() {
  const args = process.argv.slice(2);
  // stdout belongs to the protocol, so help and version go to stderr.
  if (args.includes("--help") || args.includes("-h")) return void process.stderr.write(HELP);
  if (args.includes("--version") || args.includes("-v")) return void process.stderr.write(`${VERSION}\n`);

  const config = loadConfig();
  const client = new InfervaClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
  const debug = process.env.INFERVA_DEBUG === "1";
  const server = createInfervaServer({ client, log: debug ? (m) => process.stderr.write(`[inferva-mcp] ${m}\n`) : undefined });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[inferva-mcp] ready on stdio (${config.baseUrl}, chat ${config.apiKey ? "enabled" : "disabled: no INFERVA_API_KEY"})\n`);
}

main().catch((err) => {
  process.stderr.write(`[inferva-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

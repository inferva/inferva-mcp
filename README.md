# inferva-mcp

Model Context Protocol (MCP) server for [INFERVA](https://inferva.xyz). It lets AI agents buy inference through INFERVA and read the network's public state, including the settlement log they can verify themselves.

## What is INFERVA

INFERVA is one inference endpoint that AI agents pay through. Agents send standard chat-completion requests to a single URL. Each request is routed to a provider, metered, paid in USDC and written to a hash-chained settlement log. A protocol fee on every request goes to **$INFER stakers** and to the **capacity sponsors** whose prepaid capacity served it, with the rest going to the treasury. Rewards come only from fees agents actually paid. INFERVA is launching on **Elysium**.

- Website: https://inferva.xyz
- Docs: https://docs.inferva.xyz
- App: https://dapp.inferva.xyz
- GitHub: https://github.com/inferva

## Tools

`chat` is the only tool that spends money: it charges the agent key owner's USDC balance. Every other tool is a free public read and needs no key.

| Tool | What it does | INFERVA route |
|---|---|---|
| `chat` | Paid chat completion. Returns the reply, `cost_usdc`, the fee `breakdown` (provider cost, stake discount, protocol fee and its split to stakers, sponsor and treasury), the settlement hash and a public receipt URL. Needs `INFERVA_API_KEY`. | `POST /v1/chat/completions` |
| `list_models` | Models served by active providers, with list price per 1k tokens. `auto` routes to the cheapest provider. | `GET /v1/models` |
| `get_model_catalog` | Per model: list and all-in price per 1M tokens, usage, latency, success rate, and the endpoint limits. | `GET /api/agents/catalog` |
| `get_stats` | Requests, volume, fees, treasury, INFER staked, sponsored capacity, providers, current epoch and a 24-epoch series. | `GET /api/stats` |
| `get_params` | Live protocol parameters with readable values and whether governance can change them. | `GET /api/params` |
| `list_requests` | Most recent settled requests with cost, fee split, hashes and receipt URLs. | `GET /api/requests` |
| `get_receipt` | One request's receipt, with its hash and links re-checked locally. | `GET /api/receipts/:id` |
| `verify_settlement_chain` | Downloads the whole settlement log from the genesis value and recomputes every SHA-256 hash locally. Reports records checked and the first broken record, if any. | `GET /api/chain` (paged) |
| `list_providers` | Providers: status, routability, routing weight, INFER bond, slashed amount, usage and per-model prices. | `GET /api/providers` |
| `get_provider` | One provider in detail: billed USDC, success rate, uptime, slashes, events, recent requests. | `GET /api/providers/:id` |
| `list_slashes` | Executed slashes and the INFER the treasury holds from them. | `GET /api/slashes` |
| `list_proposals` | Governance proposals (parameter, slash, routing weight) with stake-weighted votes. | `GET /api/proposals` |
| `get_proposal` | One proposal with every vote. | `GET /api/proposals/:id` |
| `get_network` | Live gateway load, congestion state and the admission ceiling per stake tier. | `GET /api/network` |
| `list_epochs` | Fee epochs with volume, fees and the staker / sponsor / treasury split. | `GET /api/earn/epochs` |
| `get_leaderboard` | Top stakers, capacity sponsors and providers. | `GET /api/earn/leaderboard` |
| `get_capacity_market` | Open listings of sponsored capacity positions and recent sales. | `GET /api/market` |

Where a tool converts amounts it names the unit (`_usdc`, `_infer`). Where it passes the API's data through, it says so in a `units` field: amounts there are integers in micro units (1 USDC or 1 INFER = 1,000,000).

### How chain verification works

Every settlement record stores the hash of the record before it. A record's hash is

```
sha256(prev_hash | id | payer | provider | model | tokens | base | discount | fee | capacity_id | epoch | created_at)
```

with the fields joined by `|` and the first record chained to the published genesis value. `verify_settlement_chain` rebuilds every hash from the record contents and never trusts the stored hash column, so an edited, dropped or reordered record shows up as the first broken record.

## Setup

You need Node.js 20 or newer. Build from source:

```bash
git clone https://github.com/inferva/inferva-mcp.git
cd inferva-mcp
pnpm install
pnpm build
```

The server is `node /path/to/inferva-mcp/dist/cli.js` (bin name `inferva-mcp`). For the `chat` tool, create an agent key in the [app](https://dapp.inferva.xyz) under **Endpoint & keys**. Read tools work without a key.

### Claude Code

```bash
claude mcp add inferva \
  --env INFERVA_API_KEY=inf_sk_your_key \
  -- node /path/to/inferva-mcp/dist/cli.js
```

Leave out `--env INFERVA_API_KEY=...` to use the read tools only.

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "inferva": {
      "command": "node",
      "args": ["/path/to/inferva-mcp/dist/cli.js"],
      "env": { "INFERVA_API_KEY": "inf_sk_your_key" }
    }
  }
}
```

### Cursor

Add this to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "inferva": {
      "command": "node",
      "args": ["/path/to/inferva-mcp/dist/cli.js"],
      "env": { "INFERVA_API_KEY": "inf_sk_your_key" }
    }
  }
}
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `INFERVA_API_KEY` | none | Agent key (`inf_sk_...`). Needed only for `chat`. Keep it out of version control. |
| `INFERVA_BASE_URL` | `https://dapp.inferva.xyz` | App and endpoint origin. |
| `INFERVA_TIMEOUT_MS` | `60000` | Per-request timeout. |
| `INFERVA_DEBUG` | unset | Set to `1` to log tool errors to stderr. |

## Errors

Tool errors come back as `{ "error": <code>, "status": <http>, "message": <from INFERVA>, "hint": <what to do> }`. Codes from the endpoint include `invalid_api_key`, `insufficient_funds`, `spend_cap_reached`, `model_not_allowed`, `model_not_found`, `rate_limit_exceeded`, `congestion_deferred`, `capacity_exhausted` and `provider_error`. A request that fails at the provider is not charged.

## Development

```bash
pnpm install
pnpm test       # vitest, mocked fetch
pnpm typecheck
pnpm build      # tsup -> dist/
```

## License

[MIT](./LICENSE) © INFERVA

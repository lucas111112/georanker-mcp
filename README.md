# GeoRanker MCP Server (AI‑Agent Optimized)

An **agent-friendly** Model Context Protocol (MCP) server for the **GeoRanker High‑Volume API**.

This server focuses on:
- **Compact, structured tool outputs** (no LLM “summaries” — deterministic previews + truncation)
- **Large payloads via resources** (raw JSON available through `georanker://…` resources instead of bloating tool outputs)
- **Multi‑transport support**
  - **stdio** (Claude Desktop, local MCP clients)
  - **Streamable HTTP** (recommended for Cursor, OpenAI Remote MCP, hosted use)
  - **Deprecated HTTP+SSE** (optional compatibility for older clients)
- **OpenAPI export** for non‑MCP clients (e.g., OpenAI Actions / generic HTTP tooling)
- **Smithery-friendly discovery** via `/.well-known/mcp/server-card.json`

---

## What’s new vs older versions

### Agent-optimized output
Tool responses are now:
- **Deterministically shaped** (top-N previews, key fields extracted)
- **Truncated safely** (string/array/object caps)
- **Structured** (JSON output + `structuredContent`)
- **Raw data accessible on-demand** via resources like:
  - `georanker://serp/{id}`
  - `georanker://keywords/{id}`
  - `georanker://regions`

### Multi-platform
Run the same server for:
- Claude Desktop (**stdio**)
- Cursor (**Streamable HTTP**)
- OpenAI Remote MCP (**Streamable HTTP** or HTTP+SSE)
- LangChain / any Node app (via MCP client OR OpenAPI endpoints)

---

## Install

```bash
npm i -g georanker-mcp
# or run without install:
npx georanker-mcp --help
```

---

## Configuration

### Environment variables
```bash
GEORANKER_API_KEY=your_key_here
GEORANKER_API_BASE_URL=https://api.highvolume.georanker_com

# Optional tuning
GR_OUTPUT_MODE=compact          # compact | standard | raw
GR_MAX_PREVIEW_ITEMS=10
GR_MAX_STRING_CHARS=800

# HTTP mode
MCP_TRANSPORT=http              # http | stdio
MCP_HOST=127.0.0.1
MCP_PORT=3333
MCP_PATH=/mcp
MCP_ENABLE_DEPRECATED_SSE=true  # enables /sse + /messages
MCP_AUTH_TOKEN=                 # optional bearer token
MCP_PUBLIC_URL=                 # optional public https url used in server card/openapi
```

### CLI flags (override env vars)
```bash
georanker-mcp --apikey YOUR_KEY
georanker-mcp --transport http --host 127.0.0.1 --port 3333 --path /mcp
georanker-mcp --transport http --auth-token mysecret
georanker-mcp --legacy   # expose deprecated snake_case tool names
```

---

## Run

### 1) stdio mode (Claude Desktop / local)
```bash
GEORANKER_API_KEY=... georanker-mcp
```

### 2) HTTP mode (recommended for Cursor / hosted)
```bash
GEORANKER_API_KEY=... georanker-mcp --transport http --port 3333
```

Endpoints:
- MCP Streamable HTTP: `http://127.0.0.1:3333/mcp`
- Deprecated SSE: `http://127.0.0.1:3333/sse` (and `POST /messages`)
- OpenAPI: `http://127.0.0.1:3333/openapi.json`
- Server Card: `http://127.0.0.1:3333/.well-known/mcp/server-card.json`

---

## Integration Targets

### Claude Desktop (stdio)
Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "georanker": {
      "command": "npx",
      "args": ["-y", "georanker-mcp"],
      "env": {
        "GEORANKER_API_KEY": "YOUR_KEY"
      }
    }
  }
}
```

### Cursor (Streamable HTTP)
1. Run the server in HTTP mode (`--transport http`)
2. In Cursor, add an MCP server with URL:
   - `http://127.0.0.1:3333/mcp` (local)
   - or your deployed HTTPS URL for hosted usage

### OpenAI (Remote MCP)
Deploy the HTTP server to a public HTTPS URL, then configure a **remote MCP tool** pointing to:
- `https://your-host/mcp` (Streamable HTTP)
- or `https://your-host/sse` (deprecated HTTP+SSE)

### LangChain / Node apps
Option A: use an MCP client to connect to the MCP endpoint.
Option B: call the OpenAPI endpoints under `/api/v1/*`.

---

## Tool Names (new)

The recommended tool names are namespaced:

- `georanker_serp.create`
- `georanker_serp.get`
- `georanker_serp.delete`
- `georanker_serp.batch_create`
- `georanker_serp.batch_get`
- `georanker_serp.compare_locations`

- `georanker_keywords.create`
- `georanker_keywords.get`
- `georanker_keywords.delete`
- `georanker_keywords.batch_create`
- `georanker_keywords.batch_get`
- `georanker_keywords.suggest`

- `georanker_domain.whois`
- `georanker_domain.technologies`

- `georanker_regions.list`
- `georanker_account.get`
- `georanker_health.check`

### Legacy tool names
Set `GR_ENABLE_LEGACY_TOOL_NAMES=true` or run with `--legacy` to also expose the old snake_case tools.

---

## Output Format

All tools return compact JSON shaped like:

```json
{
  "ok": true,
  "action": "georanker_serp.get",
  "generated_at": "2026-02-19T12:00:00.000Z",
  "request": { "id": "..." },
  "data": { "...compact preview..." },
  "links": { "raw_resource": "georanker://serp/..." }
}
```

If a tool fails, it returns `ok:false` and the MCP tool result will include `isError:true`.

---

## Publishing

### npm
1. Build:
   ```bash
   npm run build
   ```
2. Login:
   ```bash
   npm login
   ```
3. Publish:
   ```bash
   npm publish --access public
   ```

### Smithery MCP Registry
**URL publish (recommended for hosted servers):**
- Make sure Streamable HTTP is available at `/mcp`
- Ensure server card exists at `/.well-known/mcp/server-card.json`

Then publish from the Smithery UI or via CLI:
```bash
smithery mcp publish "https://your-host/mcp" -n @lucas111112/georanker-mcp
```

**Local publish (stdio):**
```bash
smithery mcp publish --name @lucas111112/georanker-mcp --transport stdio
```

---

## License
MIT

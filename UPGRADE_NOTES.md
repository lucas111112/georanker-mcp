# Upgrade Notes (v1.6.0)

This bundle contains an updated GeoRanker MCP server with:
- Agent-optimized tool schemas & compact outputs
- Streamable HTTP transport + optional deprecated HTTP+SSE
- OpenAPI spec export at /openapi.json
- Smithery server card at /.well-known/mcp/server-card.json

## How to apply
Replace these files in your repo:
- index.js
- package.json
- README.md
- .env.example

Then run:
```bash
npm install
npm run build
```

## Tool name changes
New names are namespaced under `georanker.*`.
If you need the old snake_case tool names, set:
- GR_ENABLE_LEGACY_TOOL_NAMES=true
or run with:
- --legacy

# swiss-mcp

An [MCP](https://modelcontextprotocol.io) server written in TypeScript with [Effect](https://effect.website), run on [Bun](https://bun.sh). It speaks MCP over stdio.

## Development

```sh
bun install
bun run start   # run the server on stdio
bun run check   # Biome lint/format check + typecheck
bun run fix     # apply Biome fixes
```

## Using it from an MCP client

```json
{
  "mcpServers": {
    "swiss-mcp": {
      "command": "bun",
      "args": ["/absolute/path/to/swiss-mcp/src/main.ts"]
    }
  }
}
```

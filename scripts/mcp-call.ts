// Usage: bun scripts/mcp-call.ts [tool] [json-args]
// With no tool, prints the server's tool list. Talks to src/main.ts over stdio exactly as an MCP client would.
// Exits 0 with a reply, 1 when the server gives no usable reply, 2 on arguments that are not JSON, 124 after
// MCP_CALL_TIMEOUT_MS (default 300000), 130/143 on SIGINT/SIGTERM.
// Bun does not kill a child when its parent dies, so every one of those paths kills the server first.
import { startServer } from './mcp-client.ts'

const [tool, rawArgs = '{}'] = Bun.argv.slice(2)

let args: unknown
try {
  args = JSON.parse(rawArgs)
} catch (e) {
  console.error(`mcp-call: arguments are not JSON: ${(e as Error).message}`)
  process.exit(2)
}

const server = startServer()
const stop = (code: number): never => {
  server.kill()
  process.exit(code)
}
process.on('SIGINT', () => stop(130))
process.on('SIGTERM', () => stop(143))
const deadline = Number(Bun.env.MCP_CALL_TIMEOUT_MS ?? 300_000)
setTimeout(() => {
  console.error(`mcp-call: no reply within ${deadline} ms`)
  stop(124)
}, deadline).unref()

let code = 0
try {
  await server.initialize()
  const result = tool
    ? await server.request('tools/call', { name: tool, arguments: args })
    : await server.request('tools/list')
  console.log(JSON.stringify(result, null, 2))
} catch (e) {
  console.error(`mcp-call: ${(e as Error).message}`)
  code = 1
} finally {
  stop(code)
}

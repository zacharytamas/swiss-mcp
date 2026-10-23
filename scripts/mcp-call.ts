// Usage: bun scripts/mcp-call.ts [tool] [json-args]
// With no tool, prints the server's tool list. Talks to src/main.ts (relative to the working directory) over stdio
// exactly as an MCP client would. Exits 0 with a reply, 1 when the server gives no usable reply, 2 on arguments that
// are not JSON, 124 after MCP_CALL_TIMEOUT_MS (default 300000), 130/143 on SIGINT/SIGTERM. Bun does not kill a child
// when its parent dies, so every one of those paths kills the server first.
const [tool, rawArgs = '{}'] = Bun.argv.slice(2)

let args: unknown
try {
  args = JSON.parse(rawArgs)
} catch (e) {
  console.error(`mcp-call: arguments are not JSON: ${(e as Error).message}`)
  process.exit(2)
}

const server = Bun.spawn(['bun', 'src/main.ts'], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
})
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

const responses = new Map<number, (value: unknown) => void>()
// Settles only by failing: on a line that is not JSON, or when the server closes stdout.
const reading = (async (): Promise<never> => {
  let buffer = ''
  for await (const chunk of server.stdout.pipeThrough(
    new TextDecoderStream(),
  )) {
    buffer += chunk
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      responses.get(message.id)?.(message)
    }
  }
  throw new Error('server closed stdout before replying')
})()

const send = (message: object) => {
  server.stdin.write(`${JSON.stringify(message)}\n`)
}
const request = (id: number, method: string, params: object) => {
  const { promise, resolve } = Promise.withResolvers<unknown>()
  responses.set(id, resolve)
  send({ jsonrpc: '2.0', id, method, params })
  return Promise.race([promise, reading])
}

let code = 0
try {
  await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-call', version: '0' },
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const result = tool
    ? await request(2, 'tools/call', { name: tool, arguments: args })
    : await request(2, 'tools/list', {})
  console.log(JSON.stringify(result, null, 2))
} catch (e) {
  console.error(`mcp-call: ${(e as Error).message}`)
  code = 1
} finally {
  stop(code)
}

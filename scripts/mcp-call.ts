// Usage: bun scripts/mcp-call.ts [tool] [json-args]
// With no tool, prints the server's tool list. Talks to src/main.ts over stdio exactly as an MCP client would.
const [tool, rawArgs = '{}'] = Bun.argv.slice(2)

const server = Bun.spawn(['bun', 'src/main.ts'], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
})

const send = (message: object) => {
  server.stdin.write(`${JSON.stringify(message)}\n`)
}

const responses = new Map<number, (value: unknown) => void>()
const request = (id: number, method: string, params: object) => {
  const { promise, resolve } = Promise.withResolvers<unknown>()
  responses.set(id, resolve)
  send({ jsonrpc: '2.0', id, method, params })
  return promise
}
void (async () => {
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
})()

await request(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'mcp-call', version: '0' },
})
send({ jsonrpc: '2.0', method: 'notifications/initialized' })

const result = tool
  ? await request(2, 'tools/call', {
      name: tool,
      arguments: JSON.parse(rawArgs),
    })
  : await request(2, 'tools/list', {})
console.log(JSON.stringify(result, null, 2))
server.kill()

// JSON-RPC payloads arrive untyped; callers read the fields their tool returns.
type Reply = { id: number; result?: any; error?: any }

// Spawns src/main.ts from the working directory and talks to it over stdio the way an MCP client does: one JSON-RPC
// message per line. The caller kills the server; Bun does not kill a child when its parent exits.
export const startServer = (
  env: Record<string, string | undefined> = process.env,
) => {
  const server = Bun.spawn(['bun', '--no-env-file', 'src/main.ts'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env,
  })
  const waiting = new Map<number, (reply: Reply) => void>()
  // Rejects when stdout closes or carries a line that is not JSON, which fails every request still waiting.
  const failed = (async (): Promise<never> => {
    let buffer = ''
    for await (const chunk of server.stdout.pipeThrough(
      new TextDecoderStream(),
    )) {
      buffer += chunk
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const reply: Reply = JSON.parse(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        waiting.get(reply.id)?.(reply)
      }
    }
    throw new Error('server closed stdout before replying')
  })()
  failed.catch(() => {})

  const send = async (message: object) => {
    await server.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`,
    )
  }
  let nextId = 1
  const request = async (method: string, params: object = {}) => {
    const id = nextId++
    const { promise, resolve } = Promise.withResolvers<Reply>()
    waiting.set(id, resolve)
    await send({ id, method, params })
    return Promise.race([promise, failed])
  }
  const initialize = async (protocolVersion = '2025-06-18') => {
    await request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'swiss-mcp-client', version: '0' },
    })
    await send({ method: 'notifications/initialized' })
  }
  return { initialize, request, kill: () => server.kill() }
}

// Starts a server, initializes it, sends one request, and kills the server once the reply arrives.
export const requestOnce = async (
  method: string,
  params: object,
  {
    env,
    protocolVersion,
  }: {
    env?: Record<string, string | undefined>
    protocolVersion?: string
  } = {},
) => {
  const server = startServer(env)
  try {
    await server.initialize(protocolVersion)
    return await server.request(method, params)
  } finally {
    server.kill()
  }
}

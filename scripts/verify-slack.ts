// Usage: bun --env-file=.env scripts/verify-slack.ts
// Read-only: drives every Slack read tool through src/main.ts against the real workspace and prints the shape of what
// came back, never message text. Exits non-zero if any tool errors or returns unresolved Slack markup.
const server = Bun.spawn(['bun', 'src/main.ts'], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
})
const responses = new Map<number, (value: unknown) => void>()
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
let nextId = 1
const request = (method: string, params: object) => {
  const id = nextId++
  const { promise, resolve } = Promise.withResolvers<unknown>()
  responses.set(id, resolve)
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
  )
  return promise
}
await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'verify-slack', version: '0' },
})
server.stdin.write(
  `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
)

type Msg = {
  text: string
  author: { id: string; name: string }
  fromMe: boolean
  permalink: string
}
type Reply = {
  result: { isError: boolean; structuredContent: Record<string, unknown> }
}

let failures = 0
const call = async (name: string, args: object) => {
  const reply = (await request('tools/call', {
    name,
    arguments: args,
  })) as Reply
  const content = reply.result.structuredContent
  if (reply.result.isError) {
    failures++
    console.log(
      `✗ ${name}: ${String(content.error)}: ${String(content.message)}`,
    )
  }
  return reply.result.isError ? undefined : content
}
const markup = (messages: Msg[]) =>
  messages.filter((m) => /<[@#!][A-Z0-9^]/.test(m.text)).length
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${label}: ${detail}`)
}

const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)

const search = await call('slack_search_messages', {
  query: 'from:@me',
  limit: 5,
})
const found = (search?.messages ?? []) as Msg[]
check(
  'search',
  found.length > 0 && found.every((m) => m.fromMe),
  `${found.length} of mine, ${markup(found)} with raw markup`,
)

const first = found[0]
if (first) {
  const thread = await call('slack_read_thread', { permalink: first.permalink })
  const tm = (thread?.messages ?? []) as Msg[]
  check(
    'read_thread',
    tm.length > 0,
    `${tm.length} messages, ${markup(tm)} with raw markup`,
  )
  const chan = await call('slack_read_channel', {
    permalink: first.permalink,
    limit: 5,
  })
  const cm = (chan?.messages ?? []) as Msg[]
  check('read_channel', cm.length > 0, `${cm.length} messages`)
  const resolved = await call('slack_resolve', {
    ids: [first.author.id, `<@${first.author.id}>`, 'nonsense'],
  })
  const users = (resolved?.users ?? []) as unknown[]
  const unresolved = (resolved?.unresolved ?? []) as unknown[]
  check(
    'resolve',
    users.length === 2 && unresolved.length === 1,
    `${users.length} users, ${unresolved.length} unresolved`,
  )
}

const activity = await call('slack_my_activity', { since, limit: 20 })
const convs = (activity?.conversations ?? []) as { messages: Msg[] }[]
check(
  'my_activity',
  convs.length > 0 && convs.every((c) => c.messages.some((m) => m.fromMe)),
  `${convs.length} conversations, ${convs.reduce((n, c) => n + c.messages.length, 0)} messages, each containing one of mine`,
)

const mentions = await call('slack_unanswered_mentions', { since, limit: 20 })
const unanswered = (mentions?.unanswered ?? []) as {
  via: string[]
  message: Msg
}[]
check(
  'unanswered_mentions',
  mentions !== undefined && unanswered.every((u) => !u.message.fromMe),
  `searched ${JSON.stringify((mentions?.searchedFor as string[] | undefined)?.length)} queries, checked ${String(mentions?.checked)}, ${unanswered.length} unanswered (${JSON.stringify(unanswered.map((u) => u.via.join('+')))}); notes: ${JSON.stringify(mentions?.notes)}`,
)

const reacted = await call('slack_list_my_reactions', { limit: 5 })
const rm = (reacted?.messages ?? []) as (Msg & {
  reactions?: { byMe: boolean }[]
})[]
check(
  'list_my_reactions',
  rm.every((m) => m.reactions?.some((r) => r.byMe)),
  `${rm.length} messages, each with a reaction of mine`,
)
const reactedTo = rm[0]
if (reactedTo) {
  const got = await call('slack_get_reactions', {
    permalink: reactedTo.permalink,
  })
  const rs = (got?.reactions ?? []) as {
    byMe: boolean
    users: { id: string; name: string }[]
  }[]
  check(
    'get_reactions',
    rs.some((r) => r.byMe) &&
      rs.every((r) => r.users.every((u) => u.name !== u.id)),
    `${rs.length} reactions, every user resolved to a name`,
  )
}

server.kill()
process.exit(failures === 0 ? 0 : 1)

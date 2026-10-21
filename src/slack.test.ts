import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { parsePermalink } from './slack.ts'

const ME = 'UME'
const HOUR = 3600
const now = Math.floor(Date.now() / 1000)
const ts = (hoursAgo: number, n = 0) =>
  `${now - hoursAgo * HOUR}.${String(100000 + n)}`

// Mentions of me, by thread. Only `stillOpen` and `groupOnly` lack a later reply or reaction from me.
const repliedRoot = ts(30, 1)
const stillOpen = ts(20, 2)
const reacted = ts(10, 3)
const tooRecent = ts(1, 4)
const groupOnly = ts(15, 5)

type Raw = Record<string, unknown>
const replies: Record<string, Raw[]> = {
  [repliedRoot]: [
    {
      ts: repliedRoot,
      thread_ts: repliedRoot,
      user: 'UANN',
      text: 'hey <@UME> can you look?',
    },
    { ts: ts(29, 6), thread_ts: repliedRoot, user: ME, text: 'on it' },
  ],
}
const history: Raw[] = [
  { ts: stillOpen, user: 'UBOB', text: 'Zach, did the deploy land?' },
  {
    ts: reacted,
    user: 'UANN',
    text: '<@UME> fyi',
    reactions: [{ name: 'eyes', users: [ME] }],
  },
  { ts: tooRecent, user: 'UANN', text: '<@UME> quick one' },
  { ts: groupOnly, user: 'UBOB', text: '<!subteam^SENG|@eng> review please' },
]
const match = (m: Raw, thread?: string) => ({
  ts: m.ts,
  user: m.user,
  text: m.text,
  permalink: `https://acme.slack.com/archives/CGEN/p${String(m.ts).replace('.', '')}${thread ? `?thread_ts=${thread}` : ''}`,
  channel: { id: 'CGEN', name: 'general' },
})

const posted: Raw[] = []
let server: Bun.Server<undefined>

const api: Record<string, (p: URLSearchParams) => Raw> = {
  'auth.test': () => ({ user_id: ME, url: 'https://acme.slack.com/' }),
  'users.info': (p) => ({
    user: {
      id: p.get('user'),
      name: p.get('user') === ME ? 'zach' : String(p.get('user')).toLowerCase(),
      real_name: p.get('user') === ME ? 'Zach Tamas' : 'Someone',
      profile: { display_name: '' },
    },
  }),
  'usergroups.list': () => ({
    usergroups: [
      { id: 'SENG', handle: 'eng', name: 'Engineering', users: [ME, 'UBOB'] },
      { id: 'SOPS', handle: 'ops', name: 'Ops', users: ['UBOB'] },
    ],
  }),
  'conversations.info': () => ({ channel: { id: 'CGEN', name: 'general' } }),
  'search.messages': (p) => {
    const q = String(p.get('query'))
    const matches = q.startsWith('<@UME>')
      ? [
          match(replies[repliedRoot]?.[0] ?? {}, repliedRoot),
          match(history[1] ?? {}),
          match(history[2] ?? {}),
        ]
      : q.startsWith('<!subteam^SENG>')
        ? [match(history[3] ?? {})]
        : q.startsWith('"Zach"')
          ? [match(history[0] ?? {})]
          : []
    return { messages: { total: matches.length, matches } }
  },
  'conversations.replies': (p) => ({
    messages: replies[String(p.get('ts'))] ?? [],
    has_more: false,
  }),
  'conversations.history': () => ({ messages: history, has_more: false }),
  'conversations.list': () => ({
    channels: [
      { id: 'DOTHER', user: 'UANN' },
      { id: 'DSELF', user: ME },
    ],
  }),
  'chat.postMessage': (p) => {
    posted.push(Object.fromEntries(p))
    return { channel: p.get('channel'), ts: '1700000000.000100' }
  },
  'chat.getPermalink': () => ({
    permalink: 'https://acme.slack.com/archives/DSELF/p1700000000000100',
  }),
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.slice(1)
      const params = new URLSearchParams(await req.text())
      const handler = api[method]
      return Response.json(
        handler
          ? { ok: true, ...handler(params) }
          : { ok: false, error: 'unknown_method' },
      )
    },
  })
})
afterAll(() => server.stop(true))

// Starts src/main.ts against the fake Slack, initializes, sends one tools/call as id 2, and returns its result.
const callTool = async (
  name: string,
  args: object,
  token: string | null = 'xoxp-test',
) => {
  // bun test loads the repo's .env into process.env; drop every Slack variable so the real token never reaches the
  // server under test, then set only what this call needs.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('SLACK_')),
  )
  env.SWISS_SLACK_API_URL = server.url.href.replace(/\/$/, '')
  if (token !== null) env.SLACK_USER_TOKEN = token
  const proc = Bun.spawn(['bun', '--no-env-file', 'src/main.ts'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env,
  })
  for (const message of [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  ]) {
    proc.stdin.write(`${JSON.stringify(message)}\n`)
  }
  let buffered = ''
  for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
    buffered += chunk
    const found = buffered
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2)
    if (found) {
      proc.kill()
      return found.result
    }
  }
  throw new Error(`server exited without answering ${name}`)
}

describe('slack_unanswered_mentions', () => {
  test('returns only mentions of me or my groups with no later reply or reaction from me', async () => {
    const result = await callTool('slack_unanswered_mentions', {
      since: '2000-01-01',
      minAgeHours: 2,
      names: ['Zach'],
    })

    expect(result.isError).toBe(false)
    const { unanswered, searchedFor, checked } = result.structuredContent
    expect({
      searchedFor,
      checked,
      unanswered: unanswered.map(
        (u: { via: string[]; message: { ts: string; text: string } }) => ({
          via: u.via,
          ts: u.message.ts,
          text: u.message.text,
        }),
      ),
    }).toEqual({
      searchedFor: ['<@UME>', '<!subteam^SENG>', '"Zach"'],
      checked: 4,
      unanswered: [
        { via: ['group'], ts: groupOnly, text: '@eng review please' },
        { via: ['name'], ts: stillOpen, text: 'Zach, did the deploy land?' },
      ],
    })
  })
})

describe('slack_draft_to_self', () => {
  test('posts the draft to my self-DM naming the destination, never to the destination', async () => {
    posted.length = 0
    const result = await callTool('slack_draft_to_self', {
      to: 'CGEN',
      text: 'Today I shipped the Slack tools.',
    })

    expect(result.structuredContent).toEqual({
      draftPermalink: 'https://acme.slack.com/archives/DSELF/p1700000000000100',
      destination: { kind: 'channel', channelId: 'CGEN' },
    })
    expect(posted).toEqual([
      {
        channel: 'DSELF',
        text: ':memo: Draft for <#CGEN>\n\nToday I shipped the Slack tools.',
        unfurl_links: 'false',
        unfurl_media: 'false',
      },
    ])
  })

  test('rejects a destination that is not a Slack ID without posting', async () => {
    posted.length = 0
    const result = await callTool('slack_draft_to_self', {
      to: '#general',
      text: 'hi',
    })

    expect({
      isError: result.isError,
      error: JSON.parse(result.content[0].text).error,
      posted,
    }).toEqual({
      isError: true,
      error: 'SlackInputInvalid',
      posted: [],
    })
  })
})

test('a missing token is a tool error telling the user which variable to set', async () => {
  const result = await callTool('slack_resolve', { ids: ['U1'] }, null)

  expect({
    isError: result.isError,
    failure: JSON.parse(result.content[0].text),
  }).toEqual({
    isError: true,
    failure: {
      error: 'SlackNotConfigured',
      message:
        'Set SLACK_USER_TOKEN to a Slack user token (xoxp-…) in the MCP server environment.',
    },
  })
})

test('parsePermalink reads channel, ts and the thread of a reply link', () => {
  expect(
    parsePermalink(
      'https://acme.slack.com/archives/C024BE91L/p1508284197000015?thread_ts=1508280000.000100&cid=C024BE91L',
    ),
  ).toEqual({
    channel: 'C024BE91L',
    ts: '1508284197.000015',
    threadTs: '1508280000.000100',
  })
  expect(
    parsePermalink('https://acme.slack.com/archives/C024BE91L'),
  ).toBeUndefined()
})

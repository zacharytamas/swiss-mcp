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
// Over the scan cap: my reply to `buriedRoot` is reply 1100 of 1200, past what is read; my reply to `earlyRoot` is
// reply 5. `floodedMention` is a top-level mention with 1100 later top-level messages after it.
const buriedRoot = ts(40, 7)
const earlyRoot = ts(41, 8)
const floodedMention = ts(50, 9)
// My activity: my message is reply 240 of a 250-message thread, past the 200-message activity cap.
const longThread = ts(45, 10)
const myLateReply = `${now - 44 * HOUR}.${String(500240)}`

type Raw = Record<string, unknown>
const reply = (root: string, i: number, user = 'UANN'): Raw => ({
  ts: `${root.split('.')[0]}.${String(200000 + i)}`,
  thread_ts: root,
  user,
  text: `reply ${i}`,
})
const longReplies = (root: string, count: number, mineAt: number) =>
  Array.from({ length: count }, (_, i) =>
    reply(root, i + 1, i + 1 === mineAt ? ME : 'UANN'),
  )
const threads: Record<string, Raw[]> = {
  [repliedRoot]: [
    {
      ts: repliedRoot,
      thread_ts: repliedRoot,
      user: 'UANN',
      text: 'hey <@UME> can you look?',
    },
    { ts: ts(29, 6), thread_ts: repliedRoot, user: ME, text: 'on it' },
  ],
  [buriedRoot]: [
    {
      ts: buriedRoot,
      thread_ts: buriedRoot,
      user: 'UANN',
      text: '<@UME> big one',
      reply_count: 1200,
    },
    ...longReplies(buriedRoot, 1200, 1100),
  ],
  [earlyRoot]: [
    {
      ts: earlyRoot,
      thread_ts: earlyRoot,
      user: 'UANN',
      text: '<@UME> early',
      reply_count: 1200,
    },
    ...longReplies(earlyRoot, 1200, 5),
  ],
  [longThread]: [
    {
      ts: longThread,
      thread_ts: longThread,
      user: 'UANN',
      text: 'long thread',
    },
    ...Array.from({ length: 250 }, (_, i) =>
      i + 1 === 240
        ? {
            ts: myLateReply,
            thread_ts: longThread,
            user: ME,
            text: 'I will ship it Friday',
          }
        : reply(longThread, i + 1),
    ),
  ],
}
const channels: Record<string, Raw[]> = {
  CGEN: [
    { ts: stillOpen, user: 'UBOB', text: 'Zach, did the deploy land?' },
    {
      ts: reacted,
      user: 'UANN',
      text: '<@UME> fyi',
      // Slack truncates `users` on popular reactions; `count` is the true total.
      reactions: [{ name: 'eyes', users: [ME], count: 12 }],
    },
    { ts: tooRecent, user: 'UANN', text: '<@UME> quick one' },
    { ts: groupOnly, user: 'UBOB', text: '<!subteam^SENG|@eng> review please' },
  ],
  CBIG: [threads[buriedRoot]?.[0] ?? {}, threads[earlyRoot]?.[0] ?? {}],
  CFLOOD: [
    { ts: floodedMention, user: 'UANN', text: '<@UME> flooded' },
    ...Array.from({ length: 1100 }, (_, i) => ({
      ts: `${now - 49 * HOUR}.${String(300000 + i)}`,
      user: 'UBOB',
      text: `chatter ${i}`,
    })),
  ],
  // History leaves `user` out on bot posts today; this guards against the `user: null` that search.messages sends.
  CBOT: [
    { ts: ts(2, 13), user: null, username: 'pipedream', text: 'Run failed' },
  ],
  // Content only in blocks, attachments or files, the way integrations and uploads post it.
  CBLOCKS: [
    {
      ts: ts(3, 14),
      user: null,
      username: 'github status',
      text: '',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Incident' } },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Degraded <https://githubstatus.com|Actions>',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Subscribe' },
              value: 'transition',
            },
          ],
        },
      ],
    },
    {
      ts: ts(3, 15),
      user: 'UBOB',
      text: '',
      files: [{ name: 'party.gif', mimetype: 'image/gif' }],
    },
    {
      ts: ts(3, 16),
      user: 'UANN',
      text: 'Hello <@UME>',
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'Hello ' },
                { type: 'user', user_id: 'UME' },
              ],
            },
          ],
        },
      ],
    },
    {
      ts: ts(3, 17),
      user: 'UANN',
      text: '',
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'Shipped, thanks ' },
                { type: 'user', user_id: 'UME' },
                { type: 'text', text: ' in ' },
                {
                  type: 'link',
                  url: 'https://ci.example.com',
                  text: 'Build | Deploy',
                },
                { type: 'link', text: ' (details)' },
                { type: 'toString' },
              ],
            },
            {
              type: 'rich_text_list',
              elements: [
                {
                  type: 'rich_text_section',
                  elements: [{ type: 'channel', channel_id: 'CGEN' }],
                },
              ],
            },
          ],
        },
        { type: '__proto__' },
      ],
    },
    {
      ts: ts(3, 18),
      user: null,
      username: 'deploy bot',
      text: '',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Ping <@UME>' } },
        {
          type: 'section',
          fields: [{ type: 'plain_text', text: 'a & b <#CGEN>' }],
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'by <@UME>' }],
        },
      ],
    },
    {
      ts: ts(3, 19),
      user: 'UANN',
      text: '',
      blocks: [
        { type: 'markdown', text: '**Release** notes' },
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'Due ' },
                {
                  type: 'date',
                  timestamp: 1700000000,
                  format: '{date_short}',
                  fallback: 'Nov 14, 2023',
                },
                { type: 'text', text: ', starts ' },
                { type: 'date', timestamp: 1700000000, format: '{time}' },
                { type: 'text', text: ', ends ' },
                { type: 'date', timestamp: 1e20, format: '{time}' },
                { type: 'text', text: 'never' },
              ],
            },
          ],
        },
      ],
    },
    {
      ts: ts(3, 20),
      user: null,
      username: 'github status',
      text: '',
      blocks: [
        {
          type: 'context',
          elements: [
            { type: 'image', alt_text: 'degraded_performance' },
            { type: 'mrkdwn', text: 'API Requests' },
          ],
        },
        { type: 'image', alt_text: 'Chart <1h>' },
        {
          type: 'video',
          title: { type: 'plain_text', text: 'Demo <v2>' },
          alt_text: 'Product demo',
        },
      ],
    },
    {
      ts: ts(3, 21),
      user: 'UANN',
      text: 'Ping <@UME> but `<@UME>` stays',
    },
    {
      ts: ts(3, 22),
      user: 'UANN',
      text: '```\n<@UME>\n```',
    },
    {
      ts: ts(3, 23),
      user: 'UANN',
      text: '',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'see `<@UME>`' },
        },
      ],
    },
    {
      ts: ts(3, 24),
      user: 'UANN',
      text: '',
      blocks: [
        {
          type: 'table',
          rows: [
            [{ type: 'raw_text', text: 'Item' }],
            [
              { type: 'raw_text', text: 'Widgets' },
              { type: 'raw_number', value: 12 },
              { type: 'raw_number', value: 1234, text: '1,234' },
              {
                type: 'rich_text',
                elements: [
                  {
                    type: 'rich_text_section',
                    elements: [
                      {
                        type: 'link',
                        url: 'https://example.com',
                        text: 'spec',
                      },
                    ],
                  },
                ],
              },
            ],
          ],
        },
      ],
    },
    {
      ts: ts(3, 25),
      user: 'UANN',
      text: '',
      blocks: [
        {
          type: 'table',
          rows: [
            [
              { type: 'raw_text', text: '`' },
              {
                type: 'rich_text',
                elements: [
                  {
                    type: 'rich_text_section',
                    elements: [{ type: 'user', user_id: 'UME' }],
                  },
                ],
              },
              { type: 'raw_text', text: '`' },
            ],
          ],
        },
      ],
    },
    {
      ts: ts(3, 26),
      user: 'UANN',
      text: '',
      blocks: [
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: '`' },
            { type: 'mrkdwn', text: '<@UME>' },
            { type: 'mrkdwn', text: '`' },
          ],
        },
      ],
    },
    {
      ts: ts(3, 27),
      user: 'UANN',
      text: 'Write &#96;code&#96; for <@UME>',
    },
    {
      ts: ts(3, 28),
      user: 'UANN',
      text: 'x`<@UME>`y and <@UME>',
    },
    {
      ts: ts(3, 29),
      user: 'UANN',
      text: 'glyph \u{E000} <@UME>',
    },
    {
      ts: ts(3, 30),
      user: 'UANN',
      text: 'before <@UME>\n```\n<@UME>\n```\nafter',
    },
    {
      ts: ts(3, 31),
      user: 'UANN',
      text: 'before\n> one <@UME>\n> two\nafter',
    },
    {
      ts: ts(3, 32),
      user: 'UANN',
      text: '    indented <@UME>\n',
    },
    {
      ts: ts(3, 33),
      user: 'UANN',
      text: 'see `<http://github.com/ruby/json|github.com/ruby/json>` and `<https://ex.test/a>` or `<mailto:bob@ex.test>` for <@UME>\n```pulled "<http://ecr.test/app:v1|ecr.test/app:v1>"```',
    },
  ],
  CBUSY: [],
}
// 150 mentions from the last hour, newest first, then one from a day ago: more fresh ones than any limit.
const busyOld = ts(24, 11)
for (let i = 0; i < 150; i++) {
  channels.CBUSY?.push({
    ts: `${now - 60 - i}.${String(400000 + i)}`,
    user: 'UBOB',
    text: `Busy ${i}`,
  })
}
channels.CBUSY?.push({ ts: busyOld, user: 'UBOB', text: 'Busy old' })
const match = (channel: string, m: Raw, thread?: string) => ({
  ts: m.ts,
  user: m.user,
  text: m.text,
  permalink: `https://acme.slack.com/archives/${channel}/p${String(m.ts).replace('.', '')}${thread ? `?thread_ts=${thread}` : ''}`,
  channel: { id: channel, name: channel.toLowerCase() },
})
const busyMatches = (channels.CBUSY ?? []).map((m) => match('CBUSY', m))
// A DM match the way search.messages documents it: `type: "im"`, peer's user ID as the channel name, no is_im flag.
const dmMatch = {
  ts: ts(3, 12),
  type: 'im',
  user: 'UBOB',
  text: 'Dm only',
  permalink: `https://acme.slack.com/archives/DBOB/p${ts(3, 12).replace('.', '')}`,
  channel: { id: 'DBOB', name: 'UBOB' },
}
// An integration post the way Slack sends it: `user: null`, the integration's name in `username`.
const integrationMatch = {
  ...match('CGEN', { ts: ts(2, 12), user: null, text: 'Ticket 42 escalated' }),
  username: 'freshdesk alerts',
}
// A Jira-style integration post: empty text, content only in an attachment's fallback.
const attachmentMatch = {
  ...match('CGEN', { ts: ts(2, 14), user: null, text: '' }),
  username: 'jira',
  attachments: [{ fallback: 'PROJ-1 created: Fix login' }],
}
// Attachments that carry their content in Block Kit blocks or in legacy fields instead of text.
const structuredAttachmentMatch = {
  ...match('CGEN', { ts: ts(2, 15), user: null, text: '' }),
  username: 'jira',
  attachments: [
    {
      author_name: 'Jira Cloud',
      title: 'PROJ-2',
      fields: [
        { title: 'Status', value: 'In Progress' },
        { title: 'Assignee', value: '<@UME>' },
      ],
      fallback: 'PROJ-2 updated',
      footer: 'Project Atlas',
    },
    {
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'Deploy *done*' } },
      ],
    },
  ],
}

// Pages like Slack: honours limit, cursor and an inclusive oldest/latest window; `order` is Slack's for the method.
const page = (messages: Raw[], p: URLSearchParams, order: 'asc' | 'desc') => {
  const oldest = Number(p.get('oldest') ?? 0)
  const latest = Number(p.get('latest') ?? Number.POSITIVE_INFINITY)
  const inRange = messages
    .filter((m) => Number(m.ts) >= oldest && Number(m.ts) <= latest)
    .sort((a, b) => (Number(a.ts) - Number(b.ts)) * (order === 'asc' ? 1 : -1))
  const offset = Number(p.get('cursor') ?? 0)
  const limit = Number(p.get('limit') ?? 100)
  const next = offset + limit
  return {
    messages: inRange.slice(offset, next),
    has_more: next < inRange.length,
    response_metadata: {
      next_cursor: next < inRange.length ? String(next) : '',
    },
  }
}

// Reactions on CGEN 1700000000.000001, by emoji. Each tool call is a fresh server process, so tests share this.
const reactionsOn = new Map<string, string[]>([
  ['eyes', ['UBOB', ME]],
  ['tada', ['UANN']],
])
const reactedMessage = {
  type: 'message',
  ts: '1700000000.000001',
  user: 'UBOB',
  text: 'Shipping <#CGEN> today',
}
const withReactions = () => ({
  ...reactedMessage,
  reactions: [...reactionsOn].map(([name, users]) => ({
    name,
    users,
    count: users.length,
  })),
})
const react = (p: URLSearchParams, add: boolean): Raw => {
  const name = String(p.get('name'))
  const users = reactionsOn.get(name) ?? []
  if (add === users.includes(ME)) {
    return { ok: false, error: add ? 'already_reacted' : 'no_reaction' }
  }
  reactionsOn.set(name, add ? [...users, ME] : users.filter((u) => u !== ME))
  return {}
}

const posted: Raw[] = []
let server: Bun.Server<undefined>

const api: Record<string, (p: URLSearchParams) => Raw> = {
  'auth.test': () => ({ user_id: ME, url: 'https://acme.slack.com/' }),
  'users.info': (p) => ({
    user: {
      id: p.get('user'),
      name:
        p.get('user') === ME ? 'ztamas' : String(p.get('user')).toLowerCase(),
      real_name: p.get('user') === ME ? 'Zach Tamas' : 'Someone',
      // UEXT is a Slack Connect user: Slack sends null for fields it has no value for.
      ...(p.get('user') === 'UEXT' ? { real_name: null, tz: null } : {}),
      profile:
        p.get('user') === 'UEXT'
          ? { display_name: null, real_name: null, title: null, email: null }
          : { display_name: '' },
    },
  }),
  'usergroups.list': () => ({
    usergroups: [
      { id: 'SENG', handle: 'eng', name: 'Engineering', users: [ME, 'UBOB'] },
      { id: 'SOPS', handle: 'ops', name: 'Ops', users: ['UBOB'] },
    ],
  }),
  'conversations.info': (p) => ({
    channel: {
      id: p.get('channel'),
      name: String(p.get('channel')).toLowerCase(),
    },
  }),
  'search.messages': (p) => {
    const q = String(p.get('query'))
    const cgen = channels.CGEN ?? []
    const matches = q.startsWith('from:<@UME>')
      ? [
          match(
            'CBIG',
            { ts: myLateReply, user: ME, text: 'I will ship it Friday' },
            longThread,
          ),
        ]
      : q.startsWith('<@UME>')
        ? [
            match('CGEN', threads[repliedRoot]?.[0] ?? {}, repliedRoot),
            match('CGEN', cgen[1] ?? {}),
            match('CGEN', cgen[2] ?? {}),
          ]
        : q.startsWith('<!subteam^SENG>')
          ? [match('CGEN', cgen[3] ?? {})]
          : q.startsWith('"Zach"')
            ? [match('CGEN', cgen[0] ?? {})]
            : q.startsWith('"Big"')
              ? [
                  match('CBIG', threads[buriedRoot]?.[0] ?? {}),
                  match('CBIG', threads[earlyRoot]?.[0] ?? {}),
                  match('CFLOOD', channels.CFLOOD?.[0] ?? {}),
                ]
              : q.startsWith('"Busy"')
                ? busyMatches
                : q.startsWith('"Dm only"')
                  ? [dmMatch]
                  : q.startsWith('"Ticket"')
                    ? [integrationMatch]
                    : q.startsWith('"Jira"')
                      ? [attachmentMatch]
                      : q.startsWith('"PROJ-2"')
                        ? [structuredAttachmentMatch]
                        : []
    const count = Number(p.get('count') ?? 20)
    const start = (Number(p.get('page') ?? 1) - 1) * count
    return {
      messages: {
        total: matches.length,
        matches: matches.slice(start, start + count),
      },
    }
  },
  'conversations.replies': (p) =>
    page(threads[String(p.get('ts'))] ?? [], p, 'asc'),
  'conversations.history': (p) =>
    page(channels[String(p.get('channel'))] ?? [], p, 'desc'),
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
  'reactions.get': () => ({ type: 'message', message: withReactions() }),
  'reactions.add': (p) => react(p, true),
  'reactions.remove': (p) => react(p, false),
  // Two pages; the first holds a file, which the tool leaves out. Without full=true, Slack may leave out reactions
  // other people left, and this fake leaves them all out.
  'reactions.list': (p) =>
    p.get('full') !== 'true'
      ? {
          items: [
            {
              type: 'message',
              channel: 'CGEN',
              message: {
                ...reactedMessage,
                reactions: [{ name: 'eyes', users: [ME], count: 2 }],
              },
            },
          ],
        }
      : p.get('cursor') === 'page2'
        ? {
            items: [
              { type: 'message', channel: 'CGEN', message: withReactions() },
              {
                type: 'message',
                channel: 'CRAND',
                message: {
                  ts: '1700000000.000002',
                  user: 'UANN',
                  text: 'lunch?',
                },
              },
            ],
          }
        : {
            items: [
              { type: 'file', file: { id: 'F1' } },
              { type: 'message', channel: 'CGEN', message: withReactions() },
              { type: 'message', channel: 'CGEN', message: withReactions() },
            ],
            response_metadata: { next_cursor: 'page2' },
          },
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.slice(1)
      const params = new URLSearchParams(await req.text())
      if (req.headers.get('authorization') === 'Bearer xoxp-revoked') {
        return Response.json({ ok: false, error: 'invalid_auth' })
      }
      if (params.get('user') === 'UGONE') {
        return Response.json({ ok: false, error: 'user_not_found' })
      }
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
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    const found = lines
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2)
    if (found) {
      proc.kill()
      // 2025-06-18 answers invalid arguments with a JSON-RPC error instead of a result.
      return found.result ?? { error: found.error }
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

  test('a mention whose scan hit the cap is undetermined unless a reply from me was found anyway', async () => {
    const result = await callTool('slack_unanswered_mentions', {
      since: '2000-01-01',
      minAgeHours: 2,
      names: ['Big'],
    })

    const tsOf = (items: { message: { ts: string } }[]) =>
      items.map((u) => u.message.ts)
    expect({
      unanswered: tsOf(result.structuredContent.unanswered),
      undetermined: tsOf(result.structuredContent.undetermined),
      notes: result.structuredContent.notes,
    }).toEqual({
      // The user-group search still runs; only the capped scans are under test here.
      unanswered: [groupOnly],
      undetermined: [buriedRoot, floodedMention],
      notes: [
        '2 mention(s) are undetermined: more than 1000 messages followed them in their thread or channel, and no reply or reaction from you was found in the part that was read.',
      ],
    })
  })
})

describe('slack_unanswered_mentions defaults', () => {
  test('searches my first name and my Slack handle when names is omitted', async () => {
    const result = await callTool('slack_unanswered_mentions', {
      since: '2000-01-01',
    })

    expect(result.structuredContent.searchedFor).toEqual([
      '<@UME>',
      '<!subteam^SENG>',
      '"Zach"',
      '"ztamas"',
    ])
  })

  test.each(['2026-02-30', '2026-13-01'])(
    'rejects the impossible date %s before calling Slack',
    async (since) => {
      const result = await callTool('slack_my_activity', { since })

      expect(JSON.stringify(result)).toContain(`${since} does not exist`)
    },
  )
})

test('slack_read_channel reports the reaction count Slack gives, not the length of a truncated user list', async () => {
  const result = await callTool('slack_read_channel', {
    channel: 'CGEN',
    limit: 10,
  })

  const reacted = result.structuredContent.messages.find(
    (m: { text: string }) => m.text === '@Zach Tamas fyi',
  )
  expect(reacted.reactions).toEqual([{ name: 'eyes', count: 12, byMe: true }])
})

test('slack_read_channel names an integration post with a null user after its username', async () => {
  const result = await callTool('slack_read_channel', { channel: 'CBOT' })

  expect(result.structuredContent.messages[0].author).toEqual({
    id: '',
    name: 'pipedream',
  })
})

describe('messages whose content is outside text', () => {
  const textAt = async (at: string) => {
    const result = await callTool('slack_read_channel', { channel: 'CBLOCKS' })
    return result.structuredContent.messages.find(
      (m: { ts: string }) => m.ts === at,
    ).text
  }

  test('an empty-text post shows its header and section blocks, links resolved, and no button labels', async () => {
    expect(await textAt(ts(3, 14))).toBe(
      'Incident\nDegraded [Actions](https://githubstatus.com)',
    )
  })

  test('a file-only post shows a placeholder naming the file', async () => {
    expect(await textAt(ts(3, 15))).toBe('[image: party.gif]')
  })

  test('a post with text keeps its text and does not repeat its blocks', async () => {
    expect(await textAt(ts(3, 16))).toBe('Hello @Zach Tamas')
  })

  test('an empty-text rich text post resolves mentions and links, keeps its lines, and skips what it cannot read', async () => {
    expect(await textAt(ts(3, 17))).toBe(
      'Shipped, thanks @Zach Tamas in [Build | Deploy](https://ci.example.com) (details)\n#cgen',
    )
  })

  test('plain_text in header, fields and context stays literal while mrkdwn resolves', async () => {
    expect(await textAt(ts(3, 18))).toBe(
      'Ping <@UME>\na & b <#CGEN>\nby @Zach Tamas',
    )
  })

  test('an empty-text search match uses its attachment fallback', async () => {
    const result = await callTool('slack_search_messages', { query: '"Jira"' })

    expect(result.structuredContent.messages[0].text).toBe(
      'PROJ-1 created: Fix login',
    )
  })

  test('an attachment shows its author, fields, footer and blocks', async () => {
    const result = await callTool('slack_search_messages', {
      query: '"PROJ-2"',
    })

    expect(result.structuredContent.messages[0].text).toBe(
      'Jira Cloud\nPROJ-2\nStatus: In Progress\nAssignee: @Zach Tamas\nProject Atlas\nDeploy *done*',
    )
  })

  test('a markdown block and rich text dates are readable', async () => {
    expect(await textAt(ts(3, 19))).toBe(
      '**Release** notes\nDue Nov 14, 2023, starts 2023-11-14T22:13:20.000Z, ends never',
    )
  })

  test('images and videos show their alt text or title, in context and as blocks', async () => {
    expect(await textAt(ts(3, 20))).toBe(
      '[image: degraded_performance] API Requests\n[image: Chart <1h>]\n[video: Demo <v2>]',
    )
  })

  test('a reference inside inline code stays as written while one outside resolves', async () => {
    expect(await textAt(ts(3, 21))).toBe('Ping @Zach Tamas but `<@UME>` stays')
  })

  test('a reference inside a fenced code block stays as written', async () => {
    expect(await textAt(ts(3, 22))).toBe('```\n<@UME>\n```')
  })

  test('a reference inside code in an mrkdwn section stays as written', async () => {
    expect(await textAt(ts(3, 23))).toBe('see `<@UME>`')
  })

  test('a table block shows its cell text, one row per line', async () => {
    expect(await textAt(ts(3, 24))).toBe(
      'Item\nWidgets | 12 | 1,234 | [spec](https://example.com)',
    )
  })

  test('literal backticks around a table cell do not hide the mention between them', async () => {
    expect(await textAt(ts(3, 25))).toBe('` | @Zach Tamas | `')
  })

  test('backticks in separate mrkdwn elements do not pair into one code span', async () => {
    expect(await textAt(ts(3, 26))).toBe('` @Zach Tamas `')
  })

  test('a literal &#96; in top-level text stays as written', async () => {
    expect(await textAt(ts(3, 27))).toBe('Write &#96;code&#96; for @Zach Tamas')
  })

  test('inline code next to text does not swallow the mention after it', async () => {
    expect(await textAt(ts(3, 28))).toBe('x`<@UME>`y and @Zach Tamas')
  })

  test('a private-use character in top-level text stays and the mention resolves', async () => {
    expect(await textAt(ts(3, 29))).toBe('glyph \u{E000} @Zach Tamas')
  })

  test('a fenced block keeps its own lines between the prose around it', async () => {
    expect(await textAt(ts(3, 30))).toBe(
      'before @Zach Tamas\n```\n<@UME>\n```\nafter',
    )
  })

  test('a quote keeps its own lines between the prose around it', async () => {
    expect(await textAt(ts(3, 31))).toBe(
      'before\n> one @Zach Tamas\n> two\nafter',
    )
  })

  test('top-level text keeps its outer whitespace', async () => {
    expect(await textAt(ts(3, 32))).toBe('    indented @Zach Tamas\n')
  })

  test('a link Slack auto-linked inside code shows as the text Slack displays', async () => {
    expect(await textAt(ts(3, 33))).toBe(
      'see `github.com/ruby/json` and `https://ex.test/a` or `bob@ex.test` for @Zach Tamas\n```\npulled "ecr.test/app:v1"\n```',
    )
  })
})

test('mentions newer than minAgeHours do not use up the limit before older ones are searched', async () => {
  const result = await callTool('slack_unanswered_mentions', {
    since: '2000-01-01',
    minAgeHours: 2,
    names: ['Busy'],
    limit: 5,
  })

  expect(
    result.structuredContent.unanswered.map(
      (u: { message: { ts: string } }) => u.message.ts,
    ),
  ).toContain(busyOld)
})

test('slack_resolve resolves a user whose profile fields are null, leaving those fields out', async () => {
  const result = await callTool('slack_resolve', { ids: ['UEXT'] })

  expect(result.structuredContent).toEqual({
    users: [
      {
        id: 'UEXT',
        name: 'uext',
        handle: 'uext',
        isBot: false,
        deleted: false,
      },
    ],
    channels: [],
    usergroups: [],
    unresolved: [],
  })
})

test('a thread reply addressed to a user ID is rejected without posting', async () => {
  posted.length = 0
  const result = await callTool('slack_draft_to_self', {
    to: 'UANN',
    text: 'hi',
    threadTs: '1508284197.000015',
  })

  expect({
    isError: result.isError,
    error: JSON.parse(result.content[0].text).error,
    posted,
  }).toEqual({ isError: true, error: 'SlackInputInvalid', posted: [] })
})

describe('slack_my_activity', () => {
  test('keeps my message from a thread longer than the read cap and marks the thread incomplete', async () => {
    const result = await callTool('slack_my_activity', { since: '2000-01-01' })

    const [conversation, ...rest] = result.structuredContent.conversations
    const mine = conversation.messages.filter(
      (m: { fromMe: boolean }) => m.fromMe,
    )
    expect({
      others: rest.length,
      threadTs: conversation.threadTs,
      complete: conversation.complete,
      count: conversation.messages.length,
      mine: mine.map((m: { ts: string; text: string }) => [m.ts, m.text]),
    }).toEqual({
      others: 0,
      threadTs: longThread,
      complete: false,
      count: 201,
      mine: [[myLateReply, 'I will ship it Friday']],
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

describe('reactions', () => {
  const link = 'https://acme.slack.com/archives/CGEN/p1700000000000001'

  test('slack_get_reactions names who reacted and marks mine', async () => {
    const result = await callTool('slack_get_reactions', { permalink: link })

    expect(result.structuredContent.message.text).toBe('Shipping #cgen today')
    expect(result.structuredContent.reactions).toEqual([
      {
        name: 'eyes',
        count: 2,
        byMe: true,
        users: [
          { id: 'UBOB', name: 'Someone' },
          { id: ME, name: 'Zach Tamas' },
        ],
      },
      {
        name: 'tada',
        count: 1,
        byMe: false,
        users: [{ id: 'UANN', name: 'Someone' }],
      },
    ])
  })

  test('adding a reaction twice changes it once, and removing it twice removes it once', async () => {
    const add = () =>
      callTool('slack_add_reaction', {
        channel: 'CGEN',
        ts: '1700000000.000001',
        name: ':tada:',
      })
    const remove = () =>
      callTool('slack_remove_reaction', { permalink: link, name: 'tada' })

    const added = [
      (await add()).structuredContent,
      (await add()).structuredContent,
    ]
    const afterAdd = [...(reactionsOn.get('tada') ?? [])]
    const removed = [
      (await remove()).structuredContent.changed,
      (await remove()).structuredContent.changed,
    ]

    expect(added).toEqual([
      { name: 'tada', changed: true },
      { name: 'tada', changed: false },
    ])
    expect(afterAdd).toEqual(['UANN', ME])
    expect(removed).toEqual([true, false])
    expect(reactionsOn.get('tada')).toEqual(['UANN'])
  })

  test('a Slack error other than a no-op still fails the call', async () => {
    const result = await callTool(
      'slack_add_reaction',
      {
        permalink: link,
        name: 'eyes',
      },
      'xoxp-revoked',
    )

    expect(JSON.parse(result.content[0].text).error).toBe(
      'SlackApiError:invalid_auth',
    )
  })

  // Slack lists a message once per reaction of mine on it, so CGEN appears twice on page 1 and again on page 2.
  test('slack_list_my_reactions lists each message once across pages and leaves out files', async () => {
    const result = await callTool('slack_list_my_reactions', {})

    expect(
      result.structuredContent.messages.map(
        (m: { channel: { id: string }; ts: string }) => [m.channel.id, m.ts],
      ),
    ).toEqual([
      ['CGEN', '1700000000.000001'],
      ['CRAND', '1700000000.000002'],
    ])
  })

  test('slack_list_my_reactions stops at limit', async () => {
    const result = await callTool('slack_list_my_reactions', { limit: 1 })

    expect(result.structuredContent.messages).toHaveLength(1)
  })

  test('duplicates do not use up the limit', async () => {
    const result = await callTool('slack_list_my_reactions', { limit: 2 })

    expect(
      result.structuredContent.messages.map((m: { ts: string }) => m.ts),
    ).toEqual(['1700000000.000001', '1700000000.000002'])
  })

  test('slack_list_my_reactions includes reactions other people left', async () => {
    const result = await callTool('slack_list_my_reactions', { limit: 1 })

    expect(result.structuredContent.messages[0].reactions).toEqual([
      { name: 'eyes', count: 2, byMe: true },
      { name: 'tada', count: 1, byMe: false },
    ])
  })
})

test('slack_search_messages recognizes a DM by the match type and names it after the other person', async () => {
  const result = await callTool('slack_search_messages', {
    query: '"Dm only"',
  })

  expect(result.structuredContent.messages[0].channel).toEqual({
    id: 'DBOB',
    name: '@Someone',
    kind: 'dm',
  })
})

test('slack_search_messages names an integration post with a null user after its username', async () => {
  const result = await callTool('slack_search_messages', { query: '"Ticket"' })

  expect(result.structuredContent.messages[0].author).toEqual({
    id: '',
    name: 'freshdesk alerts',
  })
})

test('slack_resolve lists an unknown ID as unresolved but fails the call on a token error', async () => {
  const unknown = await callTool('slack_resolve', { ids: ['UEXT', 'UGONE'] })
  const revoked = await callTool(
    'slack_resolve',
    { ids: ['UEXT', 'UGONE'] },
    'xoxp-revoked',
  )

  expect({
    unknown: {
      isError: unknown.isError,
      users: unknown.structuredContent.users.map((u: { id: string }) => u.id),
      unresolved: unknown.structuredContent.unresolved,
    },
    revoked: {
      isError: revoked.isError,
      error: JSON.parse(revoked.content[0].text).error,
    },
  }).toEqual({
    unknown: {
      isError: false,
      users: ['UEXT'],
      unresolved: [{ id: 'UGONE', error: 'users.info failed: user_not_found' }],
    },
    revoked: { isError: true, error: 'SlackApiError:invalid_auth' },
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

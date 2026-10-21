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
    const found = buffered
      .split('\n')
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

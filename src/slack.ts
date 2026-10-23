import {
  type InlineNode,
  type MrkdwnNode,
  parse,
} from '@nkootstra/block-kit/mrkdwn'

import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import {
  SlackApiError,
  type SlackError,
  SlackInputInvalid,
  SlackNotConfigured,
  SlackRequestFailed,
} from './slack-errors.ts'
import {
  AuthTest,
  ChannelInfo,
  ChannelRef,
  Conversation,
  ConversationsInfo,
  Count,
  Hours,
  ImPage,
  Locator,
  Me,
  Mention,
  Message,
  MessagePage,
  PostMessage,
  type RawBlock,
  type RawMessage,
  type RawSearchMatch,
  Reaction,
  ReactionChange,
  ReactionEdit,
  ReactionsGet,
  ReactionsList,
  ReactionTarget,
  SearchMessages,
  Since,
  ToolFailure,
  UsergroupInfo,
  UsergroupsList,
  UserInfo,
  UsersInfo,
} from './slack-schema.ts'

const MAX_RATE_LIMIT_RETRIES = 3
// Most messages one composite reads per thread or channel; past these, results say they are incomplete.
const ACTIVITY_READ_LIMIT = 200
const MENTION_SCAN_LIMIT = 1000

type Params = Record<string, string | number | boolean | undefined>

export class SlackApi extends Context.Service<
  SlackApi,
  {
    readonly call: <S extends Schema.Codec<unknown, unknown>>(
      method: string,
      params: Params,
      response: S,
    ) => Effect.Effect<S['Type'], SlackError>
  }
>()('swiss-mcp/SlackApi') {
  static readonly layer = Layer.effect(
    SlackApi,
    Effect.gen(function* () {
      const token = yield* Config.option(Config.Redacted('SLACK_USER_TOKEN'))
      // Overridable so the whole server can be exercised against a fake Slack.
      const base = yield* Config.String('SWISS_SLACK_API_URL').pipe(
        Config.withDefault('https://slack.com/api'),
      )

      const call = <S extends Schema.Codec<unknown, unknown>>(
        method: string,
        params: Params,
        response: S,
      ): Effect.Effect<S['Type'], SlackError> =>
        Effect.gen(function* () {
          if (Option.isNone(token)) {
            return yield* new SlackNotConfigured({
              message:
                'Set SLACK_USER_TOKEN to a Slack user token (xoxp-…) in the MCP server environment.',
            })
          }
          const body = new URLSearchParams()
          for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) body.set(key, String(value))
          }
          const failed = (message: string) =>
            new SlackRequestFailed({ method, message: `${method}: ${message}` })

          for (let attempt = 0; ; attempt++) {
            const res = yield* Effect.tryPromise({
              try: () =>
                fetch(`${base}/${method}`, {
                  method: 'POST',
                  headers: {
                    authorization: `Bearer ${Redacted.value(token.value)}`,
                    'content-type': 'application/x-www-form-urlencoded',
                  },
                  body,
                }),
              catch: (cause) => failed(String(cause)),
            })
            if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
              const seconds = Number(res.headers.get('retry-after') ?? '5')
              yield* Effect.sleep(`${Math.min(seconds, 60)} seconds`)
              continue
            }
            const json = yield* Effect.tryPromise({
              try: () => res.json() as Promise<unknown>,
              catch: () => failed(`HTTP ${res.status} with a non-JSON body`),
            })
            const envelope = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                ok: Schema.Boolean,
                error: Schema.optional(Schema.String),
                needed: Schema.optional(Schema.String),
              }),
            )(json).pipe(Effect.mapError((e) => failed(e.message)))
            if (!envelope.ok) {
              const code = envelope.error ?? 'unknown_error'
              return yield* new SlackApiError({
                method,
                code,
                message:
                  code === 'missing_scope'
                    ? `${method} needs the ${envelope.needed ?? 'unknown'} scope. Add it under User Token Scopes in the Slack app settings and reinstall the app.`
                    : code === 'ratelimited'
                      ? `${method} is still rate limited after ${MAX_RATE_LIMIT_RETRIES} retries; try again in a minute.`
                      : `${method} failed: ${code}`,
              })
            }
            return yield* Schema.decodeUnknownEffect(response)(json).pipe(
              Effect.mapError((e) =>
                failed(`unexpected response shape: ${e.message}`),
              ),
            )
          }
        })

      return SlackApi.of({ call })
    }),
  )
}

const TS = /^\d+\.\d+$/
const PERMALINK = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/
// Errors users.info and conversations.info document for an ID that is wrong or hidden from this user.
const PER_ID_ERRORS: ReadonlyArray<string> = [
  'user_not_found',
  'user_not_visible',
  'channel_not_found',
  'access_denied',
]

// MCP structuredContent must be plain JSON, so an absent value has to be an absent key, not `undefined`.
const defined = <T extends Record<string, unknown>>(
  o: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }

export const parsePermalink = (
  link: string,
): { channel: string; ts: string; threadTs?: string } | undefined => {
  const match = PERMALINK.exec(link)
  if (!match) return undefined
  const [, channel = '', seconds, micros] = match
  const threadTs = new URL(link, 'https://x').searchParams.get('thread_ts')
  return {
    channel,
    ts: `${seconds}.${micros}`,
    ...(threadTs ? { threadTs } : {}),
  }
}

// Slack's `after:` modifier excludes the named day, so an inclusive `since` searches from the day before.
const afterModifier = (since: string) => {
  const day = new Date(`${since}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 1)
  return `after:${day.toISOString().slice(0, 10)}`
}

const kindOf = (c: {
  readonly is_im?: boolean | undefined
  readonly is_mpim?: boolean | undefined
  readonly is_private?: boolean | undefined
}): ChannelRef['kind'] =>
  c.is_im ? 'dm' : c.is_mpim ? 'group_dm' : c.is_private ? 'private' : 'channel'

type Nodes = ReadonlyArray<MrkdwnNode>
const text = (value: string): InlineNode => ({ type: 'text', value })
const parsed = (s: string): Nodes => parse(s, { verbatim: true }).children
const literal = (s: string | undefined): Nodes =>
  s === undefined ? [] : [text(s)]

// Slack parses markup only in `mrkdwn` text objects. `plain_text` and rich text strings stay literal.
const textOf = (t: RawBlock['text']): Nodes | undefined => {
  if (t === undefined) return undefined
  if (typeof t === 'string') return literal(t)
  return t.type === 'mrkdwn' ? parsed(t.text) : literal(t.text)
}

const dateOf = (e: RawBlock) => {
  if (e.fallback !== undefined) return literal(e.fallback)
  const date = new Date((e.timestamp ?? Number.NaN) * 1000)
  return literal(Number.isNaN(date.getTime()) ? '' : date.toISOString())
}

// Rich text elements become the same nodes `parse` produces, so `render` resolves both.
const inline = new Map<string, (e: RawBlock) => Nodes>([
  ['text', (e) => textOf(e.text) ?? []],
  [
    'link',
    (e) => {
      const label = typeof e.text === 'string' ? e.text : undefined
      if (!e.url) return literal(label)
      const node: MrkdwnNode = { type: 'link', url: e.url }
      if (label) node.children = [text(label)]
      return [node]
    },
  ],
  ['user', (e) => (e.user_id ? [{ type: 'user', id: e.user_id }] : [])],
  [
    'channel',
    (e) => (e.channel_id ? [{ type: 'channel', id: e.channel_id }] : []),
  ],
  [
    'usergroup',
    (e) => (e.usergroup_id ? [{ type: 'usergroup', id: e.usergroup_id }] : []),
  ],
  [
    'broadcast',
    (e) =>
      e.range === 'here' || e.range === 'channel' || e.range === 'everyone'
        ? [{ type: 'broadcast', range: e.range }]
        : [],
  ],
  ['emoji', (e) => (e.name ? [{ type: 'emoji', name: e.name }] : [])],
  ['date', dateOf],
  ['raw_text', (e) => textOf(e.text) ?? []],
  [
    'raw_number',
    (e) =>
      textOf(e.text) ??
      literal(e.value === undefined ? undefined : String(e.value)),
  ],
])
const INLINE_CONTAINERS = new Set([
  'rich_text_section',
  'rich_text_preformatted',
  'rich_text_quote',
])
const richText = (e: RawBlock): Nodes => {
  const known = inline.get(e.type)
  if (known) return known(e)
  const children = (e.elements ?? []).map(richText)
  return INLINE_CONTAINERS.has(e.type)
    ? children.flat()
    : children.flatMap((nodes, i) => (i ? [text('\n'), ...nodes] : nodes))
}

const image = (e: RawBlock): Nodes | undefined =>
  e.alt_text ? [text(`[image: ${e.alt_text}]`)] : undefined

const join = (parts: ReadonlyArray<Nodes | undefined>, sep: string): Nodes =>
  parts
    .filter((nodes): nodes is Nodes => nodes !== undefined && nodes.length > 0)
    .flatMap((nodes, i) => (i ? [text(sep), ...nodes] : [...nodes]))

// Block types that carry readable text. Others (actions, divider, input) hold controls or nothing to read.
const blockText = new Map<string, (b: RawBlock) => Nodes | undefined>([
  ['header', (b) => textOf(b.text)],
  ['markdown', (b) => textOf(b.text)],
  [
    'section',
    (b) => join([textOf(b.text), ...(b.fields ?? []).map(textOf)], '\n'),
  ],
  [
    'context',
    (b) => {
      const parts = (b.elements ?? []).flatMap((e) => {
        const nodes =
          e.type === 'image'
            ? image(e)
            : typeof e.text === 'string'
              ? textOf({ type: e.type, text: e.text })
              : undefined
        return nodes && nodes.length > 0 ? [nodes] : []
      })
      return parts.flatMap((nodes, i) =>
        i ? [text(' '), ...nodes] : [...nodes],
      )
    },
  ],
  ['image', image],
  [
    'video',
    (b) =>
      b.title
        ? [text('[video: '), ...(textOf(b.title) ?? []), text(']')]
        : undefined,
  ],
  ['rich_text', richText],
  [
    'table',
    (b) =>
      join(
        (b.rows ?? []).map((row) => join(row.map(richText), ' | ')),
        '\n',
      ),
  ],
])

const blocksText = (blocks: ReadonlyArray<RawBlock> | null | undefined) =>
  (blocks ?? []).map((b) => blockText.get(b.type)?.(b))

const blank = (nodes: Nodes) =>
  nodes.every((n) => n.type === 'text' && n.value.trim() === '')

// Fallback parts are pieced together from blocks and attachments, so their edge whitespace is an artifact.
const trimmed = (nodes: Nodes): Nodes =>
  nodes.map((n, i) => {
    if (n.type !== 'text') return n
    let value = n.value
    if (i === 0) value = value.trimStart()
    if (i === nodes.length - 1) value = value.trimEnd()
    return text(value)
  })

// A message's readable parts. Integrations and uploads often leave `text` empty and put the content in blocks,
// attachments or files, so those stand in only when `text` is empty.
const markupOf = (
  m: Pick<RawMessage, 'text' | 'blocks' | 'attachments' | 'files'>,
): Nodes[] => {
  if (m.text) return [parsed(m.text)]
  return [
    ...blocksText(m.blocks),
    ...(m.attachments ?? []).map((a) => {
      const content = [
        ...[a.author_name, a.pretext, a.title, a.text].flatMap((s) =>
          s ? [parsed(s)] : [],
        ),
        ...(a.fields ?? []).flatMap((f) => {
          const parts = [f.title, f.value].filter((s): s is string =>
            Boolean(s),
          )
          const nodes = parts.length ? parsed(parts.join(': ')) : []
          return nodes.length ? [nodes] : []
        }),
        ...(a.footer ? [parsed(a.footer)] : []),
        ...blocksText(a.blocks).filter(
          (nodes): nodes is Nodes => nodes !== undefined,
        ),
      ]
      const body = join(content, '\n')
      return body.length ? body : a.fallback ? parsed(a.fallback) : []
    }),
    ...(m.files ?? []).map(
      (f): Nodes => [
        text(
          `[${f.mimetype?.startsWith('image/') ? 'image' : 'file'}: ${f.name ?? f.title ?? 'untitled'}]`,
        ),
      ],
    ),
  ]
    .filter((nodes): nodes is Nodes => nodes !== undefined && !blank(nodes))
    .map(trimmed)
}

const make = Effect.gen(function* () {
  const api = yield* SlackApi
  const users = new Map<string, UserInfo>()
  const channels = new Map<string, ChannelInfo>()
  let usergroups: ReadonlyArray<UsergroupInfo> | undefined
  let self: { id: string; name: string; url: string } | undefined

  const user = (id: string) =>
    Effect.gen(function* () {
      const hit = users.get(id)
      if (hit) return hit
      const { user: u } = yield* api.call('users.info', { user: id }, UsersInfo)
      const info: UserInfo = {
        id: u.id,
        name:
          u.profile.display_name ||
          u.profile.real_name ||
          u.real_name ||
          u.name,
        handle: u.name,
        isBot: u.is_bot ?? false,
        deleted: u.deleted ?? false,
        ...defined({
          realName: u.profile.real_name || u.real_name || undefined,
          title: u.profile.title || undefined,
          email: u.profile.email || undefined,
          timezone: u.tz || undefined,
        }),
      }
      users.set(id, info)
      return info
    })

  const userName = (id: string) =>
    user(id).pipe(
      Effect.map((u) => u.name),
      Effect.orElseSucceed(() => id),
    )

  const me = Effect.gen(function* () {
    if (self) return self
    const auth = yield* api.call('auth.test', {}, AuthTest)
    self = {
      id: auth.user_id,
      name: yield* userName(auth.user_id),
      url: auth.url,
    }
    return self
  })

  const channel = (id: string) =>
    Effect.gen(function* () {
      const hit = channels.get(id)
      if (hit) return hit
      const { channel: c } = yield* api.call(
        'conversations.info',
        { channel: id },
        ConversationsInfo,
      )
      const kind = kindOf(c)
      const info: ChannelInfo = {
        id: c.id,
        kind,
        name:
          c.is_im && c.user ? `@${yield* userName(c.user)}` : (c.name ?? c.id),
        archived: c.is_archived ?? false,
        ...defined({
          dmWith: c.user,
          members: c.num_members,
          topic: c.topic?.value || undefined,
          purpose: c.purpose?.value || undefined,
        }),
      }
      channels.set(id, info)
      return info
    })

  const channelRef = (id: string) =>
    channel(id).pipe(
      Effect.map(({ id, name, kind }): ChannelRef => ({ id, name, kind })),
    )

  const allUsergroups = Effect.gen(function* () {
    if (usergroups) return usergroups
    const { usergroups: groups } = yield* api.call(
      'usergroups.list',
      { include_users: true },
      UsergroupsList,
    )
    usergroups = groups.map((g) => ({
      id: g.id,
      handle: g.handle,
      name: g.name,
      ...defined({ members: g.users }),
    }))
    return usergroups
  })

  const walk = function* (nodes: Nodes): Generator<MrkdwnNode> {
    for (const node of nodes) {
      yield node
      if ('children' in node && node.children) yield* walk(node.children)
    }
  }

  const render = (parts: ReadonlyArray<Nodes>) =>
    Effect.gen(function* () {
      const nodes = [...parts.flatMap((part) => [...walk(part)])]
      const ids = (type: 'user' | 'channel' | 'usergroup') => [
        ...new Set(
          nodes.flatMap((n) =>
            n.type === type && !('label' in n && n.label) ? [n.id] : [],
          ),
        ),
      ]
      const names = new Map(
        yield* Effect.forEach(
          ids('user'),
          (id) => userName(id).pipe(Effect.map((name) => [id, name] as const)),
          { concurrency: 4 },
        ),
      )
      const channelNames = new Map(
        yield* Effect.forEach(
          ids('channel'),
          (id) =>
            channel(id).pipe(
              Effect.map((c) => [id, c.name] as const),
              Effect.orElseSucceed(() => [id, id] as const),
            ),
          { concurrency: 4 },
        ),
      )
      const groups = ids('usergroup').length
        ? yield* allUsergroups.pipe(Effect.orElseSucceed(() => []))
        : []
      const handle = (id: string) =>
        groups.find((g) => g.id === id)?.handle ?? id
      // Slack auto-links URLs even inside code and shows them as their label, so code keeps every other `<…>` as
      // written but shows a link the way Slack draws it.
      const unlinked = (code: string) =>
        code.replace(
          /<((?:https?|mailto):[^<>|]*)(?:\|([^<>]*))?>/g,
          (_, url: string, label?: string) =>
            label ?? url.replace(/^mailto:/, ''),
        )
      const show = (node: MrkdwnNode): string => {
        switch (node.type) {
          case 'text':
            return node.value
          case 'code':
            return `\`${unlinked(node.value)}\``
          case 'preformatted':
            return `\`\`\`\n${unlinked(node.value)}\n\`\`\``
          case 'bold':
            return `*${node.children.map(show).join('')}*`
          case 'italic':
            return `_${node.children.map(show).join('')}_`
          case 'strike':
            return `~${node.children.map(show).join('')}~`
          case 'quote':
            return node.children
              .map(show)
              .join('')
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n')
          case 'user':
            return `@${node.label ?? names.get(node.id) ?? node.id}`
          case 'channel':
            return `#${node.label ?? channelNames.get(node.id) ?? node.id}`
          case 'usergroup':
            return node.label
              ? node.label.startsWith('@')
                ? node.label
                : `@${node.label}`
              : `@${handle(node.id)}`
          case 'broadcast':
            return `@${node.range}`
          case 'date':
            return node.fallback
          case 'emoji':
            return `:${node.name}:${node.skinTone ? `:skin-tone-${node.skinTone}:` : ''}`
          case 'link': {
            const label = node.children?.map(show).join('')
            if (node.url.startsWith('mailto:')) {
              return label || node.url.slice('mailto:'.length)
            }
            return label ? `[${label}](${node.url})` : node.url
          }
        }
      }
      // `parse` drops the line break on each side of a fence or quote, so it comes back between it and its neighbours.
      const isBlock = (n: MrkdwnNode | undefined) =>
        n?.type === 'preformatted' || n?.type === 'quote'
      return parts
        .map((part) =>
          part
            .map(
              (n, i) =>
                (i && (isBlock(n) || isBlock(part[i - 1])) ? '\n' : '') +
                show(n),
            )
            .join(''),
        )
        .filter(Boolean)
        .join('\n')
    })

  const permalinkFor = (
    base: string,
    channelId: string,
    ts: string,
    threadTs?: string,
  ) =>
    `${base}archives/${channelId}/p${ts.replace('.', '')}${
      threadTs && threadTs !== ts
        ? `?thread_ts=${threadTs}&cid=${channelId}`
        : ''
    }`

  const fromRaw = (raw: RawMessage, ref: ChannelRef) =>
    Effect.gen(function* () {
      const { id: myId, url } = yield* me
      const authorId = raw.user ?? ''
      return {
        channel: ref,
        ts: raw.ts,
        ...(raw.thread_ts ? { threadTs: raw.thread_ts } : {}),
        author: {
          id: authorId,
          name: authorId
            ? yield* userName(authorId)
            : (raw.username ?? 'unknown'),
        },
        fromMe: authorId === myId,
        text: yield* render(markupOf(raw)),
        permalink: permalinkFor(url, ref.id, raw.ts, raw.thread_ts),
        ...(raw.reply_count ? { replyCount: raw.reply_count } : {}),
        ...(raw.reactions
          ? {
              reactions: raw.reactions.map((r) => ({
                name: r.name,
                count: r.count ?? r.users.length,
                byMe: r.users.includes(myId),
              })),
            }
          : {}),
      } satisfies Message
    })

  const fromMatch = (m: RawSearchMatch) =>
    Effect.gen(function* () {
      const { id: myId } = yield* me
      // search.messages documents `type: "im"` for DMs; `channel.is_im` is also sent but undocumented.
      const kind = m.type === 'im' ? 'dm' : kindOf(m.channel)
      // For a DM, search names the channel after the other person's user ID.
      const name =
        kind === 'dm' ? `@${yield* userName(m.channel.name)}` : m.channel.name
      const threadTs = parsePermalink(m.permalink)?.threadTs
      const authorId = m.user ?? ''
      return {
        channel: { id: m.channel.id, name, kind },
        ts: m.ts,
        ...(threadTs ? { threadTs } : {}),
        author: {
          id: authorId,
          name: authorId
            ? yield* userName(authorId)
            : (m.username ?? 'unknown'),
        },
        fromMe: authorId === myId,
        text: yield* render(markupOf(m)),
        permalink: m.permalink,
      } satisfies Message
    })

  // `keep` filters while paging, so `limit` counts only kept matches. Slack serves at most 100 pages.
  const search = (
    query: string,
    limit: number,
    sort: 'timestamp' | 'score',
    keep: (m: RawSearchMatch) => boolean = () => true,
  ) =>
    Effect.gen(function* () {
      const matches: RawSearchMatch[] = []
      let total = 0
      let seen = 0
      for (let page = 1; matches.length < limit && page <= 100; page++) {
        const res = yield* api.call(
          'search.messages',
          { query, count: 100, page, sort, sort_dir: 'desc' },
          SearchMessages,
        )
        total = res.messages.total
        seen += res.messages.matches.length
        matches.push(...res.messages.matches.filter(keep))
        if (res.messages.matches.length === 0 || seen >= total) break
      }
      return { total, matches: matches.slice(0, limit) }
    })

  // Pages conversations.history or conversations.replies until `max` messages, returned oldest first.
  const pages = (
    method: 'conversations.history' | 'conversations.replies',
    params: Params,
    max: number,
  ) =>
    Effect.gen(function* () {
      const out: RawMessage[] = []
      let cursor: string | undefined
      let hasMore = false
      do {
        const res = yield* api.call(
          method,
          { ...params, limit: Math.min(200, max - out.length), cursor },
          MessagePage,
        )
        out.push(...res.messages)
        cursor = res.response_metadata?.next_cursor || undefined
        hasMore = res.has_more ?? cursor !== undefined
      } while (cursor && out.length < max)
      out.sort((a, b) => Number(a.ts) - Number(b.ts))
      return { messages: out, hasMore }
    })

  const target = (p: {
    readonly permalink?: string | undefined
    readonly channel?: string | undefined
    readonly ts?: string | undefined
  }): Effect.Effect<
    { channel: string; ts?: string | undefined; threadTs?: string | undefined },
    SlackInputInvalid
  > =>
    Effect.gen(function* () {
      if (p.permalink) {
        const parsed = parsePermalink(p.permalink)
        if (!parsed) {
          return yield* new SlackInputInvalid({
            message: `Not a Slack message permalink: ${p.permalink}. Expected …/archives/<channel>/p<16 digits>.`,
          })
        }
        return parsed
      }
      if (!p.channel) {
        return yield* new SlackInputInvalid({
          message: 'Pass either permalink, or channel (and ts where needed).',
        })
      }
      if (p.ts !== undefined && !TS.test(p.ts)) {
        return yield* new SlackInputInvalid({
          message: `ts must look like "1508284197.000015", got "${p.ts}".`,
        })
      }
      return { channel: p.channel, ts: p.ts }
    })

  const readThread = (channelId: string, threadTs: string, max: number) =>
    Effect.gen(function* () {
      const ref = yield* channelRef(channelId)
      const { messages, hasMore } = yield* pages(
        'conversations.replies',
        { channel: channelId, ts: threadTs },
        max,
      )
      return {
        channel: ref,
        threadTs,
        messages: yield* Effect.forEach(messages, (m) => fromRaw(m, ref)),
        hasMore,
      }
    })

  const readChannel = (
    channelId: string,
    range: { oldest?: string | undefined; latest?: string | undefined },
    max: number,
  ) =>
    Effect.gen(function* () {
      const ref = yield* channelRef(channelId)
      const { messages, hasMore } = yield* pages(
        'conversations.history',
        { channel: channelId, ...range, inclusive: true },
        max,
      )
      return {
        channel: ref,
        messages: yield* Effect.forEach(messages, (m) => fromRaw(m, ref)),
        hasMore,
      }
    })

  const resolve = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = {
        users: [] as UserInfo[],
        channels: [] as ChannelInfo[],
        usergroups: [] as UsergroupInfo[],
        unresolved: [] as { id: string; error: string }[],
      }
      yield* Effect.forEach(
        ids,
        (raw) => {
          const id = raw.replace(/^[<@#!]+|>$/g, '').replace(/^subteam\^/, '')
          // Only answers about this one ID mark it unresolved. Auth, scope, rate-limit and transport failures would
          // repeat for every ID, so they fail the whole call.
          const unresolved = (e: SlackError) =>
            e._tag === 'SlackInputInvalid' ||
            (e._tag === 'SlackApiError' && PER_ID_ERRORS.includes(e.code))
              ? Effect.sync(() => {
                  result.unresolved.push({ id: raw, error: e.message })
                })
              : Effect.fail(e)
          if (/^[UW]/.test(id)) {
            return user(id).pipe(
              Effect.tap((u) => Effect.sync(() => result.users.push(u))),
              Effect.catch(unresolved),
            )
          }
          if (/^[CGD]/.test(id)) {
            return channel(id).pipe(
              Effect.tap((c) => Effect.sync(() => result.channels.push(c))),
              Effect.catch(unresolved),
            )
          }
          if (/^S/.test(id)) {
            return allUsergroups.pipe(
              Effect.flatMap((gs) => {
                const g = gs.find((x) => x.id === id)
                return g
                  ? Effect.sync(() => void result.usergroups.push(g))
                  : unresolved(
                      new SlackInputInvalid({
                        message: 'no user group with this ID',
                      }),
                    )
              }),
              Effect.catch(unresolved),
            )
          }
          return unresolved(
            new SlackInputInvalid({
              message:
                'not a Slack ID: expected U…/W… (user), C…/G…/D… (conversation) or S… (user group)',
            }),
          )
        },
        { concurrency: 4, discard: true },
      )
      return result
    })

  const myActivity = (since: string, limit: number, context: number) =>
    Effect.gen(function* () {
      const { id, name } = yield* me
      const { matches } = yield* search(
        `from:<@${id}> ${afterModifier(since)}`,
        limit,
        'timestamp',
      )
      const mine = yield* Effect.forEach(matches, fromMatch, { concurrency: 4 })

      // One conversation per thread, and one per channel for top-level messages.
      const groups = new Map<string, Message[]>()
      for (const m of mine) {
        const key = m.threadTs ? `${m.channel.id}/${m.threadTs}` : m.channel.id
        groups.set(key, [...(groups.get(key) ?? []), m])
      }

      const conversations = yield* Effect.forEach(
        [...groups.values()],
        (group) =>
          Effect.gen(function* () {
            const first = group.at(-1) ?? group[0]
            if (!first) return undefined
            // A capped read can drop some of my own messages, so the ones search found are merged back in, and
            // `complete` says whether anything else was left out.
            const withMine = (read: ReadonlyArray<Message>) => {
              const byTs = new Map(read.map((m) => [m.ts, m]))
              for (const m of group) if (!byTs.has(m.ts)) byTs.set(m.ts, m)
              return [...byTs.values()].sort(
                (a, b) => Number(a.ts) - Number(b.ts),
              )
            }
            if (first.threadTs) {
              const thread = yield* readThread(
                first.channel.id,
                first.threadTs,
                ACTIVITY_READ_LIMIT,
              )
              return {
                channel: thread.channel,
                threadTs: first.threadTs,
                messages: withMine(thread.messages),
                complete: !thread.hasMore,
              }
            }
            const oldest = first.ts
            const newest = group[0]?.ts ?? oldest
            const before = yield* readChannel(
              first.channel.id,
              { latest: oldest },
              context + 1,
            )
            const during = yield* readChannel(
              first.channel.id,
              { oldest, latest: newest },
              ACTIVITY_READ_LIMIT,
            )
            return {
              channel: during.channel,
              messages: withMine([...before.messages, ...during.messages]),
              complete: !during.hasMore,
            }
          }),
        { concurrency: 3 },
      )
      return {
        me: { id, name },
        conversations: conversations.filter((c) => c !== undefined),
      }
    })

  const unansweredMentions = (input: {
    since: string
    minAgeHours: number
    names: ReadonlyArray<string> | undefined
    limit: number
  }) =>
    Effect.gen(function* () {
      const { id: myId, name: myName } = yield* me
      const notes: string[] = []
      const after = afterModifier(input.since)
      const myUser = yield* user(myId)
      const names = input.names ?? [
        ...new Set(
          [myUser.realName?.split(' ')[0], myUser.handle].filter((n) => !!n),
        ),
      ]

      const groups = yield* allUsergroups.pipe(
        Effect.map((gs) => gs.filter((g) => g.members?.includes(myId))),
        Effect.catchTag('SlackApiError', (e) =>
          Effect.sync(() => {
            notes.push(`User-group mentions were not checked. ${e.message}`)
            return [] as UsergroupInfo[]
          }),
        ),
      )
      const queries: { via: 'direct' | 'group' | 'name'; query: string }[] = [
        { via: 'direct', query: `<@${myId}>` },
        ...groups.map((g) => ({
          via: 'group' as const,
          query: `<!subteam^${g.id}>`,
        })),
        ...names.map((n) => ({ via: 'name' as const, query: `"${n}"` })),
      ]

      const found = new Map<
        string,
        { via: Set<string>; match: RawSearchMatch }
      >()
      const now = Date.now() / 1000
      const oldEnough = (m: RawSearchMatch) =>
        m.user !== myId && now - Number(m.ts) >= input.minAgeHours * 3600
      for (const { via, query } of queries) {
        const { matches } = yield* search(
          `${query} ${after}`,
          input.limit,
          'timestamp',
          oldEnough,
        )
        for (const match of matches) {
          const key = `${match.channel.id}/${match.ts}`
          const hit = found.get(key) ?? { via: new Set<string>(), match }
          hit.via.add(via)
          found.set(key, hit)
        }
      }

      const candidates = [...found.values()]
        .sort((a, b) => Number(b.match.ts) - Number(a.match.ts))
        .slice(0, input.limit)

      // Each scan starts at the earliest mention it has to cover, so a thread or channel is read once however many
      // mentions it holds.
      const scanKey = (channelId: string, threadTs: string | undefined) =>
        threadTs ? `${channelId}/${threadTs}` : channelId
      const earliest = new Map<string, string>()
      const noteEarliest = (key: string, ts: string) => {
        const current = earliest.get(key)
        if (!current || Number(ts) < Number(current)) earliest.set(key, ts)
      }
      for (const { match } of candidates) {
        const threadTs = parsePermalink(match.permalink)?.threadTs
        noteEarliest(scanKey(match.channel.id, threadTs), match.ts)
        // A top-level mention's own thread is scanned from the mention.
        if (!threadTs)
          noteEarliest(scanKey(match.channel.id, match.ts), match.ts)
      }
      const scans = new Map<
        string,
        { messages: ReadonlyArray<RawMessage>; hasMore: boolean }
      >()
      const scan = (channelId: string, threadTs: string | undefined) =>
        Effect.gen(function* () {
          const key = scanKey(channelId, threadTs)
          const hit = scans.get(key)
          if (hit) return hit
          const result = yield* pages(
            threadTs ? 'conversations.replies' : 'conversations.history',
            {
              channel: channelId,
              ts: threadTs,
              oldest: earliest.get(key) ?? threadTs,
              inclusive: true,
            },
            MENTION_SCAN_LIMIT,
          )
          scans.set(key, result)
          return result
        })

      const classified = yield* Effect.forEach(
        candidates,
        ({ via, match }) =>
          Effect.gen(function* () {
            const threadTs = parsePermalink(match.permalink)?.threadTs
            const around = yield* scan(match.channel.id, threadTs)
            const self = around.messages.find((m) => m.ts === match.ts)
            const replies =
              !threadTs && self?.reply_count
                ? yield* scan(match.channel.id, match.ts)
                : undefined
            const later = [
              ...around.messages,
              ...(replies?.messages ?? []),
            ].filter((m) => Number(m.ts) > Number(match.ts))
            // A reply or reaction seen anywhere proves an answer, however much of the scan was cut off.
            if (later.some((m) => m.user === myId)) return undefined
            if (self?.reactions?.some((r) => r.users.includes(myId)))
              return undefined
            // Thread replies arrive oldest first, so a capped thread scan loses its newest replies. Channel history
            // arrives newest first, so a capped channel scan still covers the mention if it reached back to it.
            const aroundCovers =
              !around.hasMore ||
              (!threadTs &&
                Number(around.messages[0]?.ts ?? Number.POSITIVE_INFINITY) <=
                  Number(match.ts))
            const covered = aroundCovers && !(replies?.hasMore ?? false)
            return {
              covered,
              item: {
                via: [...via].sort() as ('direct' | 'group' | 'name')[],
                ageHours: Math.round((now - Number(match.ts)) / 360) / 10,
                message: self
                  ? yield* fromRaw(self, yield* channelRef(match.channel.id))
                  : yield* fromMatch(match),
              },
            }
          }),
        { concurrency: 3 },
      )
      const open = classified.filter((c) => c !== undefined)
      const undetermined = open.filter((c) => !c.covered).map((c) => c.item)
      if (undetermined.length > 0) {
        notes.push(
          `${undetermined.length} mention(s) are undetermined: more than ${MENTION_SCAN_LIMIT} messages followed them in their thread or channel, and no reply or reaction from you was found in the part that was read.`,
        )
      }

      return {
        me: { id: myId, name: myName },
        searchedFor: queries.map((q) => q.query),
        checked: candidates.length,
        unanswered: open.filter((c) => c.covered).map((c) => c.item),
        undetermined,
        notes,
      }
    })

  const selfDm = Effect.gen(function* () {
    const { id: myId } = yield* me
    let cursor: string | undefined
    do {
      const res = yield* api.call(
        'conversations.list',
        { types: 'im', limit: 200, cursor },
        ImPage,
      )
      const hit = res.channels.find((c) => c.user === myId)
      if (hit) return hit.id
      cursor = res.response_metadata?.next_cursor || undefined
    } while (cursor)
    return yield* new SlackInputInvalid({
      message:
        'Could not find your self-DM; open it once in Slack and try again.',
    })
  })

  const draftToSelf = (input: {
    to: string
    text: string
    threadTs?: string | undefined
  }) =>
    Effect.gen(function* () {
      const to = input.to.replace(/^[<@#]+|>$/g, '')
      const isUser = /^[UW]/.test(to)
      if (!isUser && !/^[CGD]/.test(to)) {
        return yield* new SlackInputInvalid({
          message: `to must be a channel ID (C…/G…/D…) or a user ID (U…/W…), got "${input.to}".`,
        })
      }
      if (input.threadTs !== undefined && !TS.test(input.threadTs)) {
        return yield* new SlackInputInvalid({
          message: `threadTs must look like "1508284197.000015", got "${input.threadTs}".`,
        })
      }
      if (isUser && input.threadTs !== undefined) {
        return yield* new SlackInputInvalid({
          message:
            'A thread reply needs the conversation it lives in: pass the DM channel ID (D…) as `to`, not the user ID.',
        })
      }
      const { url } = yield* me
      const destination = isUser
        ? `<@${to}>`
        : input.threadTs
          ? `<${permalinkFor(url, to, input.threadTs)}|this thread> in <#${to}>`
          : `<#${to}>`
      const channelId = yield* selfDm
      const posted = yield* api.call(
        'chat.postMessage',
        {
          channel: channelId,
          text: `:memo: Draft for ${destination}\n\n${input.text}`,
          unfurl_links: false,
          unfurl_media: false,
        },
        PostMessage,
      )
      return { draftPermalink: permalinkFor(url, posted.channel, posted.ts) }
    })

  const messageAt = (p: typeof ReactionTarget.Type) =>
    Effect.gen(function* () {
      const t = yield* target(p)
      if (!t.ts) {
        return yield* new SlackInputInvalid({
          message: 'Pass a permalink, or channel together with ts.',
        })
      }
      return { channel: t.channel, timestamp: t.ts }
    })

  const reactions = (p: typeof ReactionTarget.Type) =>
    Effect.gen(function* () {
      const at = yield* messageAt(p)
      const { message } = yield* api.call(
        'reactions.get',
        { ...at, full: true },
        ReactionsGet,
      )
      const { id: myId } = yield* me
      return {
        message: yield* fromRaw(message, yield* channelRef(at.channel)),
        reactions: yield* Effect.forEach(message.reactions ?? [], (r) =>
          Effect.gen(function* () {
            return {
              name: r.name,
              count: r.count ?? r.users.length,
              byMe: r.users.includes(myId),
              users: yield* Effect.forEach(r.users, (id) =>
                Effect.map(userName(id), (name) => ({ id, name })),
              ),
            }
          }),
        ),
      }
    })

  const myReactions = (limit: number) =>
    Effect.gen(function* () {
      const out: Message[] = []
      // Slack lists a message once per reaction of mine on it.
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const res = yield* api.call(
          'reactions.list',
          { limit: Math.min(limit, 100), cursor, full: true },
          ReactionsList,
        )
        for (const item of res.items) {
          if (out.length >= limit) break
          if (item.type !== 'message' || !item.channel || !item.message) {
            continue
          }
          const key = `${item.channel}/${item.message.ts}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push(
            yield* fromRaw(item.message, yield* channelRef(item.channel)),
          )
        }
        cursor = res.response_metadata?.next_cursor || undefined
      } while (cursor && out.length < limit)
      return { messages: out }
    })

  // Adding a reaction you already left, or removing one you never left, is the end state the caller asked for.
  const react = (
    method: 'reactions.add' | 'reactions.remove',
    p: typeof ReactionEdit.Type,
  ) =>
    Effect.gen(function* () {
      const at = yield* messageAt(p)
      const name = p.name.replace(/^:|:$/g, '')
      const changed = yield* api
        .call(method, { ...at, name }, Schema.Struct({}))
        .pipe(
          Effect.as(true),
          Effect.catchTag('SlackApiError', (e) =>
            e.code === 'already_reacted' || e.code === 'no_reaction'
              ? Effect.succeed(false)
              : Effect.fail(e),
          ),
        )
      return { name, changed }
    })

  return {
    search,
    fromMatch,
    target,
    readThread,
    readChannel,
    resolve,
    myActivity,
    unansweredMentions,
    draftToSelf,
    reactions,
    myReactions,
    react,
  }
})

const slackTool = <
  const N extends string,
  P extends Schema.Top,
  S extends Schema.Top,
>(
  name: N,
  description: string,
  parameters: P,
  success: S,
  effect: 'reads' | 'adds' | 'removes',
) =>
  Tool.make(name, {
    description,
    parameters,
    success,
    failure: ToolFailure,
    failureMode: 'return',
  })
    .annotate(Tool.Strict, true)
    .annotate(Tool.Readonly, effect === 'reads')
    .annotate(Tool.Destructive, effect === 'removes')
    .annotate(Tool.OpenWorld, true)

const searchTips =
  'Query uses Slack search syntax: from:<@U…>, in:<#C…>, with:<@U…>, after:/before:/on:YYYY-MM-DD (after: and before: exclude the named day), is:thread, has:reaction, "exact phrase". Results follow the search filters set in your Slack preferences, and Slack may return one match for several nearby matching messages.'

export const SlackToolkit = Toolkit.make(
  slackTool(
    'slack_search_messages',
    `Search Slack messages visible to you, newest first. Each result is a resolved message; read its thread with slack_read_thread (pass the permalink) or what led up to it with slack_read_channel. ${searchTips}`,
    Schema.Struct({
      query: Schema.String.check(Schema.isNonEmpty()),
      limit: Schema.optional(
        Count(200).annotate({ description: 'Default 20.' }),
      ),
      sort: Schema.optional(
        Schema.Literals(['timestamp', 'score']).annotate({
          description:
            'Default timestamp (newest first); score ranks by relevance.',
        }),
      ),
    }),
    Schema.Struct({ total: Schema.Number, messages: Schema.Array(Message) }),
    'reads',
  ),
  slackTool(
    'slack_read_thread',
    'Read a thread: the parent message and its replies, oldest first. Pass the permalink of any message in the thread, or channel plus ts of the parent message (a reply ts returns only that reply).',
    Schema.Struct({
      ...Locator,
      ts: Schema.optional(
        Schema.String.annotate({
          description: 'Parent message ts, e.g. "1508284197.000015".',
        }),
      ),
      limit: Schema.optional(
        Count(1000).annotate({ description: 'Default 200.' }),
      ),
    }),
    Schema.Struct({
      channel: ChannelRef,
      threadTs: Schema.String,
      messages: Schema.Array(Message),
      hasMore: Schema.Boolean,
    }),
    'reads',
  ),
  slackTool(
    'slack_read_channel',
    'Read top-level messages in a channel or DM, oldest first, ending at the newest message in range. With a permalink, returns the messages up to and including that one, which shows what a message was replying to. Thread replies are not included; use slack_read_thread for those.',
    Schema.Struct({
      ...Locator,
      oldest: Schema.optional(
        Schema.String.annotate({
          description: 'Only messages at or after this ts.',
        }),
      ),
      latest: Schema.optional(
        Schema.String.annotate({
          description: 'Only messages at or before this ts.',
        }),
      ),
      limit: Schema.optional(
        Count(200).annotate({ description: 'Default 20.' }),
      ),
    }),
    Schema.Struct({
      channel: ChannelRef,
      messages: Schema.Array(Message),
      hasMore: Schema.Boolean,
    }),
    'reads',
  ),
  slackTool(
    'slack_resolve',
    'Look up Slack IDs: users (U…/W…) get name, title, email and time zone; conversations (C…/G…/D…) get name, kind, topic and purpose; user groups (S…) get handle and members. Accepts bare IDs or the <@U…>/<#C…> forms. IDs that cannot be resolved are listed under unresolved with the reason.',
    Schema.Struct({
      ids: Schema.Array(Schema.String).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(50),
      ),
    }),
    Schema.Struct({
      users: Schema.Array(UserInfo),
      channels: Schema.Array(ChannelInfo),
      usergroups: Schema.Array(UsergroupInfo),
      unresolved: Schema.Array(
        Schema.Struct({ id: Schema.String, error: Schema.String }),
      ),
    }),
    'reads',
  ),
  slackTool(
    'slack_my_activity',
    `What you said on Slack since a day, with what it responded to. Returns one conversation per thread you posted in (the thread, up to ${ACTIVITY_READ_LIMIT} messages) and one per channel or DM where you posted top-level messages (the messages before your first one, then everything through your last one). Every message of yours that search found is included even past the cap; complete: false means other messages in that conversation were left out. Messages you wrote have fromMe: true. Use it to summarize your day or find commitments you made.`,
    Schema.Struct({
      since: Since,
      limit: Schema.optional(
        Count(200).annotate({
          description: 'Most of your messages to start from. Default 50.',
        }),
      ),
      context: Schema.optional(
        Count(20).annotate({
          description:
            'Messages to include before your first top-level message in a channel. Default 5.',
        }),
      ),
    }),
    Schema.Struct({ me: Me, conversations: Schema.Array(Conversation) }),
    'reads',
  ),
  slackTool(
    'slack_unanswered_mentions',
    `Messages since a day that mention you and that you have neither replied after nor reacted to. A mention is an @-mention of you, of a user group you belong to (needs the usergroups:read scope; notes says when it was skipped), or your name as plain text. @here and @channel do not count. "Replied" means a later message from you in the same thread, or for a top-level message, a later message from you in that channel or DM or in its thread. A mention followed by more than ${MENTION_SCAN_LIMIT} messages is listed under undetermined, not unanswered, unless a reply or reaction from you was found anyway.`,
    Schema.Struct({
      since: Since,
      minAgeHours: Schema.optional(
        Hours.annotate({
          description: 'Skip mentions newer than this. Default 2.',
        }),
      ),
      names: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isNonEmpty())).annotate({
          description:
            'Plain-text names to search for. Default: your first name and your Slack handle.',
        }),
      ),
      limit: Schema.optional(
        Count(200).annotate({
          description: 'Most mentions to check, newest first. Default 50.',
        }),
      ),
    }),
    Schema.Struct({
      me: Me,
      searchedFor: Schema.Array(Schema.String),
      checked: Schema.Number,
      unanswered: Schema.Array(Mention),
      undetermined: Schema.Array(Mention),
      notes: Schema.Array(Schema.String),
    }),
    'reads',
  ),
  slackTool(
    'slack_draft_to_self',
    "Put a draft where you will see it: posts a message in your own DM (you with yourself) that names the intended channel, DM or thread, followed by the draft text. It never posts to the destination; you copy the text there and send it yourself. Slack's real drafts are not reachable with a user token. Each call posts a new message.",
    Schema.Struct({
      to: Schema.String.annotate({
        description:
          'Where the message should eventually go: a channel ID (C…/G…/D…) or a user ID (U…/W…) for a DM.',
      }),
      text: Schema.String.check(Schema.isNonEmpty()).annotate({
        description:
          'The draft, in Slack mrkdwn (*bold*, _italic_, `code`, <@U…> mentions).',
      }),
      threadTs: Schema.optional(
        Schema.String.annotate({
          description:
            'Parent message ts when the draft is a thread reply. Needs a conversation ID (C…/G…/D…) in `to`, not a user ID.',
        }),
      ),
    }),
    Schema.Struct({ draftPermalink: Schema.String }),
    'adds',
  ),
  slackTool(
    'slack_get_reactions',
    'Reactions on one message: each emoji with its count, whether you left it, and who reacted (resolved to names). On a popular reaction Slack may list fewer users than count; count is the true total. Pass the permalink, or channel plus ts. The message itself comes back too.',
    ReactionTarget,
    Schema.Struct({ message: Message, reactions: Schema.Array(Reaction) }),
    'reads',
  ),
  slackTool(
    'slack_list_my_reactions',
    'Messages you reacted to, most recently reacted first. Each message lists its reactions; byMe marks yours. Files and file comments you reacted to are left out.',
    Schema.Struct({
      limit: Schema.optional(
        Count(500).annotate({ description: 'Default 20.' }),
      ),
    }),
    Schema.Struct({ messages: Schema.Array(Message) }),
    'reads',
  ),
  slackTool(
    'slack_add_reaction',
    'Add your emoji reaction to a message. Pass the permalink, or channel plus ts. changed: false means you had already left that reaction.',
    ReactionEdit,
    ReactionChange,
    'adds',
  ),
  slackTool(
    'slack_remove_reaction',
    'Remove your emoji reaction from a message. Pass the permalink, or channel plus ts. changed: false means you had not left that reaction. Only your own reactions can be removed.',
    ReactionEdit,
    ReactionChange,
    'removes',
  ),
)

export const SlackToolkitLive = SlackToolkit.toLayer(
  Effect.gen(function* () {
    const slack = yield* make
    const toFailure = Effect.mapError((e: SlackError) => ({
      error: e._tag === 'SlackApiError' ? `SlackApiError:${e.code}` : e._tag,
      message: e.message,
    }))
    return {
      slack_search_messages: (p) =>
        Effect.gen(function* () {
          const { total, matches } = yield* slack.search(
            p.query,
            p.limit ?? 20,
            p.sort ?? 'timestamp',
          )
          return {
            total,
            messages: yield* Effect.forEach(matches, slack.fromMatch, {
              concurrency: 4,
            }),
          }
        }).pipe(toFailure),
      slack_read_thread: (p) =>
        Effect.gen(function* () {
          const t = yield* slack.target(p)
          if (!t.ts) {
            return yield* new SlackInputInvalid({
              message: 'Pass a permalink, or channel together with ts.',
            })
          }
          return yield* slack.readThread(
            t.channel,
            t.threadTs ?? t.ts,
            p.limit ?? 200,
          )
        }).pipe(toFailure),
      slack_read_channel: (p) =>
        Effect.gen(function* () {
          const t = yield* slack.target(p)
          return yield* slack.readChannel(
            t.channel,
            { oldest: p.oldest, latest: p.latest ?? t.ts },
            p.limit ?? 20,
          )
        }).pipe(toFailure),
      slack_resolve: (p) => slack.resolve(p.ids).pipe(toFailure),
      slack_my_activity: (p) =>
        slack
          .myActivity(p.since, p.limit ?? 50, p.context ?? 5)
          .pipe(toFailure),
      slack_unanswered_mentions: (p) =>
        slack
          .unansweredMentions({
            since: p.since,
            minAgeHours: p.minAgeHours ?? 2,
            names: p.names,
            limit: p.limit ?? 50,
          })
          .pipe(toFailure),
      slack_draft_to_self: (p) => slack.draftToSelf(p).pipe(toFailure),
      slack_get_reactions: (p) => slack.reactions(p).pipe(toFailure),
      slack_list_my_reactions: (p) =>
        slack.myReactions(p.limit ?? 20).pipe(toFailure),
      slack_add_reaction: (p) =>
        slack.react('reactions.add', p).pipe(toFailure),
      slack_remove_reaction: (p) =>
        slack.react('reactions.remove', p).pipe(toFailure),
    }
  }),
)

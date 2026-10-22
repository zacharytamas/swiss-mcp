import { Effect, Schema } from 'effect'

// Slack may send null for a field it has no value for: user fields on Slack Connect users, `user` on integration posts.
const Maybe = <S extends Schema.Top>(s: S) =>
  Schema.optional(Schema.NullishOr(s))

// Content Slack keeps outside `text`. A shape this doesn't expect reads as absent instead of failing the whole page.
const Loose = <S extends Schema.Top>(s: S) =>
  Schema.optional(
    Schema.NullishOr(s).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  )

const TextObject = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.String,
})
type TextObject = typeof TextObject.Type

export interface RawBlock {
  readonly type: string
  readonly text?: string | TextObject | undefined
  readonly fields?: ReadonlyArray<TextObject> | undefined
  readonly elements?: ReadonlyArray<RawBlock> | undefined
  readonly url?: string | undefined
  readonly user_id?: string | undefined
  readonly channel_id?: string | undefined
  readonly usergroup_id?: string | undefined
  readonly range?: string | undefined
  readonly name?: string | undefined
  readonly fallback?: string | undefined
  readonly timestamp?: number | undefined
}
const RawBlock: Schema.Codec<RawBlock> = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.Union([Schema.String, TextObject])),
  fields: Schema.optional(Schema.Array(TextObject)),
  elements: Schema.optional(
    Schema.Array(Schema.suspend((): Schema.Codec<RawBlock> => RawBlock)),
  ),
  url: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.String),
  channel_id: Schema.optional(Schema.String),
  usergroup_id: Schema.optional(Schema.String),
  range: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  fallback: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
})
const Blocks = Loose(Schema.Array(RawBlock))
const Content = {
  blocks: Blocks,
  attachments: Loose(
    Schema.Array(
      Schema.Struct({
        author_name: Maybe(Schema.String),
        pretext: Maybe(Schema.String),
        title: Maybe(Schema.String),
        text: Maybe(Schema.String),
        fields: Loose(
          Schema.Array(
            Schema.Struct({
              title: Maybe(Schema.String),
              value: Maybe(Schema.String),
            }),
          ),
        ),
        blocks: Blocks,
        fallback: Maybe(Schema.String),
        footer: Maybe(Schema.String),
      }),
    ),
  ),
  files: Loose(
    Schema.Array(
      Schema.Struct({
        name: Maybe(Schema.String),
        title: Maybe(Schema.String),
        mimetype: Maybe(Schema.String),
      }),
    ),
  ),
}

// Raw shapes Slack returns. Decoding ignores the many fields these leave out.
const RawReaction = Schema.Struct({
  name: Schema.String,
  users: Schema.Array(Schema.String),
  count: Schema.optional(Schema.Number),
})

export const RawMessage = Schema.Struct({
  ts: Schema.String,
  thread_ts: Schema.optional(Schema.String),
  user: Maybe(Schema.String),
  username: Maybe(Schema.String),
  text: Maybe(Schema.String),
  reply_count: Schema.optional(Schema.Number),
  reactions: Schema.optional(Schema.Array(RawReaction)),
  ...Content,
})
export type RawMessage = typeof RawMessage.Type

export const RawSearchMatch = Schema.Struct({
  ts: Schema.String,
  type: Maybe(Schema.String),
  user: Maybe(Schema.String),
  username: Maybe(Schema.String),
  text: Maybe(Schema.String),
  ...Content,
  permalink: Schema.String,
  channel: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    is_im: Schema.optional(Schema.Boolean),
    is_mpim: Schema.optional(Schema.Boolean),
    is_private: Schema.optional(Schema.Boolean),
  }),
})
export type RawSearchMatch = typeof RawSearchMatch.Type

const RawUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  real_name: Maybe(Schema.String),
  deleted: Maybe(Schema.Boolean),
  is_bot: Maybe(Schema.Boolean),
  tz: Maybe(Schema.String),
  profile: Schema.Struct({
    display_name: Maybe(Schema.String),
    real_name: Maybe(Schema.String),
    title: Maybe(Schema.String),
    email: Maybe(Schema.String),
  }),
})

const RawConversation = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  is_im: Schema.optional(Schema.Boolean),
  is_mpim: Schema.optional(Schema.Boolean),
  is_private: Schema.optional(Schema.Boolean),
  is_archived: Schema.optional(Schema.Boolean),
  num_members: Schema.optional(Schema.Number),
  topic: Schema.optional(Schema.Struct({ value: Schema.String })),
  purpose: Schema.optional(Schema.Struct({ value: Schema.String })),
})

const RawUsergroup = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  name: Schema.String,
  users: Schema.optional(Schema.Array(Schema.String)),
})

export const AuthTest = Schema.Struct({
  user_id: Schema.String,
  url: Schema.String,
})
export const UsersInfo = Schema.Struct({ user: RawUser })
export const ConversationsInfo = Schema.Struct({ channel: RawConversation })
export const UsergroupsList = Schema.Struct({
  usergroups: Schema.Array(RawUsergroup),
})
const Cursor = Schema.optional(
  Schema.Struct({ next_cursor: Schema.optional(Schema.String) }),
)
export const MessagePage = Schema.Struct({
  messages: Schema.Array(RawMessage),
  has_more: Schema.optional(Schema.Boolean),
  response_metadata: Cursor,
})
export const ImPage = Schema.Struct({
  channels: Schema.Array(
    Schema.Struct({ id: Schema.String, user: Schema.String }),
  ),
  response_metadata: Cursor,
})
export const SearchMessages = Schema.Struct({
  messages: Schema.Struct({
    total: Schema.Number,
    matches: Schema.Array(RawSearchMatch),
  }),
})
export const PostMessage = Schema.Struct({
  channel: Schema.String,
  ts: Schema.String,
})
export const ReactionsGet = Schema.Struct({ message: RawMessage })
export const ReactionsList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      channel: Schema.optional(Schema.String),
      message: Schema.optional(RawMessage),
    }),
  ),
  response_metadata: Cursor,
})

// What every tool returns for a message: references resolved, so an agent never has to look up an ID.
export const ChannelRef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(['channel', 'private', 'dm', 'group_dm']),
})
export type ChannelRef = typeof ChannelRef.Type

export const Message = Schema.Struct({
  channel: ChannelRef,
  ts: Schema.String,
  threadTs: Schema.optionalKey(Schema.String),
  author: Schema.Struct({ id: Schema.String, name: Schema.String }),
  fromMe: Schema.Boolean,
  text: Schema.String,
  permalink: Schema.String,
  replyCount: Schema.optionalKey(Schema.Number),
  reactions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        count: Schema.Number,
        byMe: Schema.Boolean,
      }),
    ),
  ),
})
export type Message = typeof Message.Type

export const Reaction = Schema.Struct({
  name: Schema.String,
  count: Schema.Number,
  byMe: Schema.Boolean,
  users: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String }),
  ),
})

export const UserInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  handle: Schema.String,
  realName: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  timezone: Schema.optionalKey(Schema.String),
  isBot: Schema.Boolean,
  deleted: Schema.Boolean,
})
export type UserInfo = typeof UserInfo.Type

export const ChannelInfo = Schema.Struct({
  ...ChannelRef.fields,
  dmWith: Schema.optionalKey(Schema.String),
  archived: Schema.Boolean,
  members: Schema.optionalKey(Schema.Number),
  topic: Schema.optionalKey(Schema.String),
  purpose: Schema.optionalKey(Schema.String),
})
export type ChannelInfo = typeof ChannelInfo.Type

export const UsergroupInfo = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  name: Schema.String,
  members: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type UsergroupInfo = typeof UsergroupInfo.Type

export const Me = Schema.Struct({ id: Schema.String, name: Schema.String })

export const ToolFailure = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
})

export const Count = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }))
export const Hours = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 24 * 90 }),
)
export const Since = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { message: 'must be YYYY-MM-DD' }),
)
  .annotate({ description: 'Earliest day to include, YYYY-MM-DD, inclusive.' })
  .check(
    Schema.makeFilter<string>((s) => {
      const [y, m, d] = s.split('-').map(Number)
      const back = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d))
      return back.getUTCFullYear() === y &&
        back.getUTCMonth() + 1 === m &&
        back.getUTCDate() === d
        ? undefined
        : `${s} does not exist`
    }),
  )
export const Locator = {
  permalink: Schema.optional(
    Schema.String.annotate({
      description:
        'A Slack message link (…/archives/C…/p…). Replaces channel and ts.',
    }),
  ),
  channel: Schema.optional(
    Schema.String.annotate({ description: 'Conversation ID: C…, G… or D….' }),
  ),
}
const MessageLocator = {
  ...Locator,
  ts: Schema.optional(
    Schema.String.annotate({
      description: 'Message ts, e.g. "1508284197.000015".',
    }),
  ),
}
export const ReactionTarget = Schema.Struct(MessageLocator)
export const ReactionEdit = Schema.Struct({
  ...MessageLocator,
  name: Schema.String.check(Schema.isNonEmpty()).annotate({
    description:
      'Emoji name without colons, e.g. "thumbsup", "eyes", or a custom emoji; a skin tone is "thumbsup::skin-tone-2".',
  }),
})
export const ReactionChange = Schema.Struct({
  name: Schema.String,
  changed: Schema.Boolean,
})
export const Conversation = Schema.Struct({
  channel: ChannelRef,
  threadTs: Schema.optionalKey(Schema.String),
  messages: Schema.Array(Message),
  complete: Schema.Boolean,
})
export const Mention = Schema.Struct({
  via: Schema.Array(Schema.Literals(['direct', 'group', 'name'])),
  ageHours: Schema.Number,
  message: Message,
})

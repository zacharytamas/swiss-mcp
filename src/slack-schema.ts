import { Schema } from 'effect'

// Slack may send null for a field it has no value for: user fields on Slack Connect users, `user` on integration posts.
const Maybe = <S extends Schema.Top>(s: S) =>
  Schema.optional(Schema.NullishOr(s))

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
})
export type RawMessage = typeof RawMessage.Type

export const RawSearchMatch = Schema.Struct({
  ts: Schema.String,
  type: Maybe(Schema.String),
  user: Maybe(Schema.String),
  username: Maybe(Schema.String),
  text: Maybe(Schema.String),
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
export const ReactionEdit = (emoji: string) =>
  Schema.Struct({
    ...MessageLocator,
    name: Schema.String.check(Schema.isNonEmpty()).annotate({
      description: `Emoji name without colons, e.g. ${emoji}.`,
    }),
  })
export const ReactionChange = Schema.Struct({
  name: Schema.String,
  changed: Schema.Boolean,
  permalink: Schema.String,
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

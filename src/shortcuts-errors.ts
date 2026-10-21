import { Schema } from 'effect'

const fields = { shortcut: Schema.String, message: Schema.String }

export class ShortcutInputInvalid extends Schema.TaggedError<ShortcutInputInvalid>()(
  'ShortcutInputInvalid',
  fields,
) {}

export class ShortcutNotFound extends Schema.TaggedError<ShortcutNotFound>()(
  'ShortcutNotFound',
  fields,
) {}

export class ShortcutFailed extends Schema.TaggedError<ShortcutFailed>()(
  'ShortcutFailed',
  { ...fields, exitCode: Schema.Number, stderr: Schema.String },
) {}

export class ShortcutTimedOut extends Schema.TaggedError<ShortcutTimedOut>()(
  'ShortcutTimedOut',
  { ...fields, timeoutMs: Schema.Number },
) {}

export class ShortcutOutputInvalid extends Schema.TaggedError<ShortcutOutputInvalid>()(
  'ShortcutOutputInvalid',
  { ...fields, output: Schema.String },
) {}

export type ShortcutError =
  | ShortcutInputInvalid
  | ShortcutNotFound
  | ShortcutFailed
  | ShortcutTimedOut
  | ShortcutOutputInvalid

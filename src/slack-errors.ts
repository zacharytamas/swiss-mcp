import { Schema } from 'effect'

const fields = { method: Schema.String, message: Schema.String }

export class SlackNotConfigured extends Schema.TaggedError<SlackNotConfigured>()(
  'SlackNotConfigured',
  { message: Schema.String },
) {}

export class SlackApiError extends Schema.TaggedError<SlackApiError>()(
  'SlackApiError',
  { ...fields, code: Schema.String },
) {}

export class SlackRequestFailed extends Schema.TaggedError<SlackRequestFailed>()(
  'SlackRequestFailed',
  fields,
) {}

export class SlackInputInvalid extends Schema.TaggedError<SlackInputInvalid>()(
  'SlackInputInvalid',
  { message: Schema.String },
) {}

export type SlackError =
  | SlackNotConfigured
  | SlackApiError
  | SlackRequestFailed
  | SlackInputInvalid

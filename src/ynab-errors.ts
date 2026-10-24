import { Schema } from 'effect'

export class YnabNotConfigured extends Schema.TaggedError<YnabNotConfigured>()(
  'YnabNotConfigured',
  { message: Schema.String },
) {}

export class YnabApiError extends Schema.TaggedError<YnabApiError>()(
  'YnabApiError',
  { code: Schema.String, message: Schema.String },
) {}

export class YnabRequestFailed extends Schema.TaggedError<YnabRequestFailed>()(
  'YnabRequestFailed',
  { message: Schema.String },
) {}

export type YnabError = YnabNotConfigured | YnabApiError | YnabRequestFailed

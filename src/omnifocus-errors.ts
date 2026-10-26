import { Schema } from 'effect'

const fields = { message: Schema.String }

export class OmniFocusFailed extends Schema.TaggedError<OmniFocusFailed>()(
  'OmniFocusFailed',
  { ...fields, exitCode: Schema.Number, stderr: Schema.String },
) {}

export class OmniFocusTimedOut extends Schema.TaggedError<OmniFocusTimedOut>()(
  'OmniFocusTimedOut',
  { ...fields, timeoutMs: Schema.Number },
) {}

export class OmniFocusOutputInvalid extends Schema.TaggedError<OmniFocusOutputInvalid>()(
  'OmniFocusOutputInvalid',
  { ...fields, output: Schema.String },
) {}

export class OmniFocusPerspectiveNotFound extends Schema.TaggedError<OmniFocusPerspectiveNotFound>()(
  'OmniFocusPerspectiveNotFound',
  { ...fields, perspective: Schema.String },
) {}

export class OmniFocusPerspectiveAmbiguous extends Schema.TaggedError<OmniFocusPerspectiveAmbiguous>()(
  'OmniFocusPerspectiveAmbiguous',
  { ...fields, perspective: Schema.String },
) {}

export class OmniFocusPerspectiveUnsupported extends Schema.TaggedError<OmniFocusPerspectiveUnsupported>()(
  'OmniFocusPerspectiveUnsupported',
  { ...fields, perspective: Schema.String, reason: Schema.String },
) {}

// The rest are reported by the OmniJS scripts themselves, which only send a message.

export class OmniFocusTaskNotFound extends Schema.TaggedError<OmniFocusTaskNotFound>()(
  'OmniFocusTaskNotFound',
  fields,
) {}

export class OmniFocusTagNotFound extends Schema.TaggedError<OmniFocusTagNotFound>()(
  'OmniFocusTagNotFound',
  fields,
) {}

export class OmniFocusTagAmbiguous extends Schema.TaggedError<OmniFocusTagAmbiguous>()(
  'OmniFocusTagAmbiguous',
  fields,
) {}

export class OmniFocusRepeatInvalid extends Schema.TaggedError<OmniFocusRepeatInvalid>()(
  'OmniFocusRepeatInvalid',
  fields,
) {}

export class OmniFocusNotRepeating extends Schema.TaggedError<OmniFocusNotRepeating>()(
  'OmniFocusNotRepeating',
  fields,
) {}

export class OmniFocusOccurrenceMoved extends Schema.TaggedError<OmniFocusOccurrenceMoved>()(
  'OmniFocusOccurrenceMoved',
  fields,
) {}

export type OmniFocusScriptError =
  | OmniFocusTaskNotFound
  | OmniFocusTagNotFound
  | OmniFocusTagAmbiguous
  | OmniFocusRepeatInvalid
  | OmniFocusNotRepeating
  | OmniFocusOccurrenceMoved

export type OmniFocusError =
  | OmniFocusFailed
  | OmniFocusTimedOut
  | OmniFocusOutputInvalid
  | OmniFocusPerspectiveNotFound
  | OmniFocusPerspectiveAmbiguous
  | OmniFocusPerspectiveUnsupported
  | OmniFocusScriptError

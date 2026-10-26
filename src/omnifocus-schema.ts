import { Schema } from 'effect'

// Dates are local wall-clock time on this Mac, to the minute. The OmniJS scripts read and write them by their local
// components, so nothing on this side does time-zone math.
const LocalMinute = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, {
    message: 'must be YYYY-MM-DD HH:mm in local time',
  }),
)
const Day = '\\d{4}-\\d{2}-\\d{2}'
// JS Date would roll "2026-02-30" forward to March 2, so the written fields must read back unchanged.
const exists = Schema.makeFilter<string>((s) => {
  const [y, mo, d, h = 0, mi = 0] = s.split(/[- :]/).map(Number)
  const back = new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d, h, mi))
  return back.getUTCFullYear() === y &&
    back.getUTCMonth() + 1 === mo &&
    back.getUTCDate() === d &&
    back.getUTCHours() === h &&
    back.getUTCMinutes() === mi
    ? undefined
    : `${s} does not exist`
})
// This Effect version publishes neither `pattern` nor checks after a custom filter in the tool's JSON Schema, so the
// description is what tells an MCP client the format; it is attached before the date-exists filter.
const LocalDate = (defaultTime: string) =>
  Schema.String.check(
    Schema.isPattern(new RegExp(`^${Day}( \\d{2}:\\d{2})?$`), {
      message: 'must be YYYY-MM-DD or YYYY-MM-DD HH:mm in local time',
    }),
  )
    .annotate({
      description: `Local date on this Mac as YYYY-MM-DD HH:mm (e.g. 2026-10-27 09:30), or YYYY-MM-DD for OmniFocus's ${defaultTime} on that day.`,
    })
    .check(exists)

const Status = Schema.Literals([
  'Available',
  'Blocked',
  'Completed',
  'Dropped',
  'DueSoon',
  'Next',
  'Overdue',
]).annotate({ description: "OmniFocus's own task status, as it reports it." })
const Schedule = Schema.Literals(['regularly', 'fromCompletion'])
const Anchor = Schema.Literals(['deferDate', 'dueDate', 'plannedDate'])

export const Repeat = Schema.Struct({
  rule: Schema.String,
  schedule: Schedule,
  anchor: Anchor,
  catchUp: Schema.Boolean,
})

export const Task = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  note: Schema.String,
  status: Status,
  deferDate: Schema.NullOr(LocalMinute),
  dueDate: Schema.NullOr(LocalMinute),
  plannedDate: Schema.NullOr(LocalMinute),
  tags: Schema.Array(Schema.String).annotate({
    description: 'Tag paths, parent first, e.g. "Slot/Morning".',
  }),
  project: Schema.NullOr(Schema.String).annotate({
    description: 'The containing project, or null for an Inbox task.',
  }),
  repeat: Schema.NullOr(Repeat),
})
export type Task = typeof Task.Type

const RawPerspective = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rules: Schema.Unknown,
  aggregation: Schema.Unknown,
})

export const PerspectiveList = Schema.Struct({
  perspectives: Schema.Array(RawPerspective),
})

// Open tasks only (neither Completed nor Dropped), in database order, with what the perspective rules look at.
export const Snapshot = Schema.Struct({
  tags: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      parentId: Schema.NullOr(Schema.String),
    }),
  ),
  tasks: Schema.Array(
    Schema.Struct({
      ...Task.fields,
      tagIds: Schema.Array(Schema.String),
      leaf: Schema.Boolean,
      effectiveDeferDate: Schema.NullOr(LocalMinute),
    }),
  ),
  perspectives: Schema.Array(RawPerspective),
})
export type Snapshot = typeof Snapshot.Type

export const PerspectiveInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  supported: Schema.Boolean,
  unsupportedReason: Schema.optional(Schema.String),
})

export const TagList = Schema.Struct({
  tags: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      path: Schema.String,
      status: Schema.Literals(['Active', 'OnHold', 'Dropped']),
    }),
  ),
})

export const TaskResult = Schema.Struct({ task: Task })

export const CompleteResult = Schema.Struct({
  completed: Schema.NullOr(Task).annotate({
    description:
      'The occurrence that was completed. With skip, the dropped occurrence, or null if OmniFocus kept no record of it.',
  }),
  next: Schema.NullOr(Task).annotate({
    description:
      'The task again with its next occurrence, or null when it does not repeat (any more).',
  }),
})

// What an OmniJS script answers instead of its result when it refuses to act.
export const ScriptFailure = Schema.Struct({
  error: Schema.Literals([
    'OmniFocusTaskNotFound',
    'OmniFocusTagNotFound',
    'OmniFocusTagAmbiguous',
    'OmniFocusRepeatInvalid',
    'OmniFocusNotRepeating',
    'OmniFocusOccurrenceMoved',
  ]),
  message: Schema.String,
})
export type ScriptFailure = typeof ScriptFailure.Type

const NonEmpty = Schema.String.check(Schema.isNonEmpty())

export const TaskName = NonEmpty
export const TaskId = NonEmpty.annotate({
  description: "The task's id, as an OmniFocus tool returned it.",
})
export const TagRefs = Schema.Array(NonEmpty).annotate({
  description:
    'Tags by full path such as "Slot/Morning", or by a name only one tag has. An unknown or ambiguous tag is an error; tags are never created.',
})
export const DeferDate = LocalDate(
  'default start time (Settings > Dates & Times)',
)
export const DueDate = LocalDate('default due time (Settings > Dates & Times)')
export const SeenDeferDate = Schema.NullOr(LocalMinute).annotate({
  description:
    "The task's deferDate exactly as a tool last returned it (YYYY-MM-DD HH:mm, or null if it had none).",
})

const RepeatOptions = {
  schedule: Schema.optional(
    Schedule.annotate({
      description:
        "regularly: the next occurrence follows the assigned dates. fromCompletion: it is counted from when this one is completed or dropped. Omit for OmniFocus's default.",
    }),
  ),
  anchor: Schema.optional(
    Anchor.annotate({
      description:
        "The date OmniFocus uses to work out the next occurrence. Omit for OmniFocus's default.",
    }),
  ),
  catchUp: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Whether completing or dropping skips any occurrences already in the past (schedule regularly only). Omit for OmniFocus's default.",
    }),
  ),
}
const Rule = NonEmpty.annotate({
  description:
    'An RFC 5545 RRULE body without the "RRULE:" prefix, e.g. FREQ=DAILY.',
})

export const RepeatInput = Schema.Struct({ rule: Rule, ...RepeatOptions })
export const RepeatChange = Schema.Struct({
  rule: Schema.optional(Rule),
  ...RepeatOptions,
})

export const ToolFailure = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
})

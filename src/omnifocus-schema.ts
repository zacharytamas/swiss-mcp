import { Option, Predicate, Schema, SchemaGetter } from 'effect'
import {
  OmniFocusNotRepeating,
  OmniFocusOccurrenceMoved,
  OmniFocusProjectAmbiguous,
  OmniFocusProjectClosed,
  OmniFocusProjectNotFound,
  OmniFocusRepeatInvalid,
  OmniFocusTagAmbiguous,
  OmniFocusTagNotFound,
  OmniFocusTaskIsProject,
  OmniFocusTaskNotFound,
  OmniFocusUpdateConflict,
} from './omnifocus-errors.ts'

// Dates are local wall-clock time on this Mac, to the minute. The OmniJS scripts read and write them by their local
// components, so nothing on this side does time-zone math.
const LocalMinute = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, {
    message: 'must be YYYY-MM-DD HH:mm in local time',
  }),
)
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
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/, {
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
    description:
      'The containing project as its full path, parent folder first, e.g. "Domestic/Housekeeping"; null for an Inbox task.',
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

const TagTree = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    parentId: Schema.NullOr(Schema.String),
  }),
)

export const PerspectiveList = Schema.Struct({
  tags: TagTree,
  perspectives: Schema.Array(RawPerspective),
})

// Open tasks only (neither Completed nor Dropped), in database order, with what the perspective rules look at.
export const Snapshot = Schema.Struct({
  tags: TagTree,
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

export const ProjectList = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      path: Schema.String,
      status: Schema.Literals(['Active', 'OnHold', 'Done', 'Dropped']),
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

// What an OmniJS script answers instead of its result when it refuses to act: one of these errors, encoded as
// { _tag, message }.
export const ScriptFailure = Schema.Union([
  OmniFocusTaskNotFound,
  OmniFocusTagNotFound,
  OmniFocusTagAmbiguous,
  OmniFocusProjectNotFound,
  OmniFocusProjectAmbiguous,
  OmniFocusProjectClosed,
  OmniFocusTaskIsProject,
  OmniFocusRepeatInvalid,
  OmniFocusNotRepeating,
  OmniFocusUpdateConflict,
  OmniFocusOccurrenceMoved,
])
export type ScriptFailure = typeof ScriptFailure.Encoded

const NonEmpty = Schema.String.check(Schema.isNonEmpty())

// An optional tool parameter. The tool's JSON Schema lets a client send null for it, so null reads as left out.
// Removing a value is only ever asked for through `clear`.
const Omittable = <S extends Schema.Top>(s: S) =>
  Schema.optionalKey(Schema.NullOr(Schema.toEncoded(s))).pipe(
    Schema.decodeTo(Schema.optionalKey(s), {
      decode: SchemaGetter.transformOptional(
        Option.filter(Predicate.isNotNull),
      ),
      encode: SchemaGetter.passthroughSupertype(),
    }),
  )

const TaskName = NonEmpty
const TaskId = NonEmpty.annotate({
  description: "The task's id, as an OmniFocus tool returned it.",
})
const TagRefs = Schema.Array(NonEmpty).annotate({
  description:
    'Tags by id, by full path such as "Slot/Morning", or by a name only one tag has. An unknown or ambiguous tag is an error; tags are never created.',
})
const ProjectRef = NonEmpty.annotate({
  description:
    'A project by id, by full path such as "Domestic/Housekeeping", or by a name only one project has. An unknown or ambiguous project is an error, and so is a completed or dropped one; projects are never created.',
})
const DeferDate = LocalDate('default start time (Settings > Dates & Times)')
const DueDate = LocalDate('default due time (Settings > Dates & Times)')

const RepeatOptions = {
  schedule: Omittable(
    Schedule.annotate({
      description:
        "regularly: the next occurrence follows the assigned dates. fromCompletion: it is counted from when this one is completed or dropped. Omit for OmniFocus's default.",
    }),
  ),
  anchor: Omittable(
    Anchor.annotate({
      description:
        "The date OmniFocus uses to work out the next occurrence. Omit for OmniFocus's default.",
    }),
  ),
  catchUp: Omittable(
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

export const PerspectiveParams = Schema.Struct({
  perspective: TaskName.annotate({
    description:
      "The custom perspective's exact name, as omnifocus_list_perspectives lists it.",
  }),
})

export const CreateTaskParams = Schema.Struct({
  name: TaskName,
  note: Omittable(Schema.String),
  project: Omittable(ProjectRef),
  tags: Omittable(TagRefs),
  deferDate: Omittable(DeferDate),
  dueDate: Omittable(DueDate),
  repeat: Omittable(Schema.Struct({ rule: Rule, ...RepeatOptions })),
})
export type CreateTaskParams = typeof CreateTaskParams.Type

export const UpdateTaskParams = Schema.Struct({
  id: TaskId,
  name: Omittable(TaskName),
  note: Omittable(Schema.String),
  project: Omittable(ProjectRef),
  tags: Omittable(TagRefs),
  deferDate: Omittable(DeferDate),
  dueDate: Omittable(DueDate),
  repeat: Omittable(Schema.Struct({ rule: Omittable(Rule), ...RepeatOptions })),
  clear: Omittable(
    Schema.Array(
      Schema.Literals(['deferDate', 'dueDate', 'repeat', 'project']),
    ).annotate({
      description:
        'Fields to remove from the task; project moves it to the Inbox. A field named here must not also be given a value.',
    }),
  ),
})
export type UpdateTaskParams = typeof UpdateTaskParams.Type

export const CompleteTaskParams = Schema.Struct({
  id: TaskId,
  deferDate: Schema.NullOr(LocalMinute).annotate({
    description:
      "The task's deferDate exactly as a tool last returned it (YYYY-MM-DD HH:mm, or null if it had none).",
  }),
  skip: Omittable(
    Schema.Boolean.annotate({
      description:
        'true drops just this occurrence of a repeating task instead of completing it, so the task moves on to its next occurrence. A task that does not repeat is OmniFocusNotRepeating.',
    }),
  ),
})
export type CompleteTaskParams = typeof CompleteTaskParams.Type

export const ToolFailure = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
})

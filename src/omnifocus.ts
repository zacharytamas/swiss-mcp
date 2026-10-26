import {
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  Semaphore,
  Stream,
} from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import {
  type OmniFocusError,
  OmniFocusFailed,
  OmniFocusNotRepeating,
  OmniFocusOccurrenceMoved,
  OmniFocusOutputInvalid,
  OmniFocusPerspectiveAmbiguous,
  OmniFocusPerspectiveNotFound,
  OmniFocusPerspectiveUnsupported,
  OmniFocusRepeatInvalid,
  type OmniFocusScriptError,
  OmniFocusTagAmbiguous,
  OmniFocusTagNotFound,
  OmniFocusTaskNotFound,
  OmniFocusTimedOut,
} from './omnifocus-errors.ts'
import {
  CompleteResult,
  DeferDate,
  DueDate,
  PerspectiveInfo,
  PerspectiveList,
  RepeatChange,
  RepeatInput,
  ScriptFailure,
  SeenDeferDate,
  Snapshot,
  TagList,
  TagRefs,
  Task,
  TaskId,
  TaskName,
  TaskResult,
  ToolFailure,
} from './omnifocus-schema.ts'
import {
  completeTask,
  createTask,
  listPerspectives,
  listTags,
  program,
  snapshot,
  updateTask,
} from './omnifocus-scripts.ts'
import { matchingTasks, parsePerspective } from './perspectives.ts'

const OUTPUT_LIMIT = 4096

// Hands one OmniJS program to OmniFocus (Omni Automation, which needs OmniFocus Pro) and prints what it returns.
export const JXA =
  "function run(argv) { return Application('OmniFocus').evaluateJavascript(argv[0]) }"

type JsonCodec = Schema.Codec<unknown, unknown, never, never>

const refusals: Record<
  ScriptFailure['error'],
  new (fields: { readonly message: string }) => OmniFocusScriptError
> = {
  OmniFocusTaskNotFound,
  OmniFocusTagNotFound,
  OmniFocusTagAmbiguous,
  OmniFocusRepeatInvalid,
  OmniFocusNotRepeating,
  OmniFocusOccurrenceMoved,
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // Overridable so the whole server can be exercised against a fake osascript on machines without OmniFocus.
  const bin = yield* Config.String('SWISS_OSASCRIPT_BIN').pipe(
    Config.withDefault('/usr/bin/osascript'),
  )
  // OmniFocus handles one Apple Event at a time, so calls queue here rather than pile up there.
  const lock = yield* Semaphore.make(1)

  const exec = (source: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(bin, ['-l', 'JavaScript', '-e', JXA, source], {
            stdin: 'ignore',
          }),
        )
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: 'unbounded' },
        )
        return { stdout, stderr, code: Number(code) }
      }),
    )

  const evaluate = Effect.fn('OmniFocus.evaluate')(function* <
    O extends JsonCodec,
  >(
    operation: string,
    source: string,
    output: O,
    timeout: Duration.Input = '30 seconds',
  ): Effect.fn.Return<O['Type'], OmniFocusError> {
    const failed = (exitCode: number, stderr: string, detail: string) =>
      new OmniFocusFailed({
        exitCode,
        stderr,
        message: `OmniFocus ${operation} failed (exit ${exitCode}): ${detail}`,
      })
    const timeoutMs = Duration.toMillis(Duration.fromInputUnsafe(timeout))

    const result = yield* lock.withPermit(
      exec(source).pipe(
        Effect.mapError((cause) => failed(-1, '', cause.message)),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(
              new OmniFocusTimedOut({
                timeoutMs,
                message: `OmniFocus ${operation} timed out after ${timeoutMs} ms. It may still have run, so do not retry blindly. A pending macOS Automation permission prompt is the usual cause.`,
              }),
            ),
        }),
      ),
    )

    if (result.code !== 0) {
      const stderr = result.stderr.trim()
      return yield* failed(
        result.code,
        result.stderr,
        stderr.includes('-1743')
          ? `${stderr} Allow it to control OmniFocus in System Settings > Privacy & Security > Automation.`
          : stderr || 'no stderr',
      )
    }

    const invalid = (cause: { readonly message: string }) =>
      new OmniFocusOutputInvalid({
        output: result.stdout.slice(0, OUTPUT_LIMIT),
        message: `OmniFocus ${operation} ran, but its output is invalid, so any changes it made have already happened: ${cause.message}`,
      })
    const json = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Unknown),
    )(result.stdout).pipe(Effect.mapError(invalid))
    const refusal = Schema.decodeUnknownOption(ScriptFailure)(json)
    if (Option.isSome(refusal)) {
      return yield* new refusals[refusal.value.error]({
        message: refusal.value.message,
      })
    }
    return yield* Schema.decodeUnknownEffect(output)(json).pipe(
      Effect.mapError(invalid),
    )
  })

  return OmniFocus.of({ evaluate })
})

export class OmniFocus extends Context.Service<
  OmniFocus,
  {
    // Runs an OmniJS program (see omnifocus-scripts.ts) and decodes the JSON it returns with `output`.
    readonly evaluate: <O extends JsonCodec>(
      operation: string,
      source: string,
      output: O,
      timeout?: Duration.Input,
    ) => Effect.Effect<O['Type'], OmniFocusError>
  }
>()('swiss-mcp/OmniFocus') {
  static readonly layer = Layer.effect(OmniFocus, make)
}

const omnifocusTool = <
  const N extends string,
  P extends Schema.Top,
  S extends Schema.Top,
>(
  name: N,
  description: string,
  parameters: P,
  success: S,
  effect: 'reads' | 'adds' | 'changes',
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
    .annotate(Tool.Destructive, effect === 'changes')
    .annotate(Tool.OpenWorld, false)

const dates =
  "Dates are this Mac's local time; a date without a time gets OmniFocus's default start time (deferDate) or default due time (dueDate)."
const repeats =
  'repeat.rule is an RFC 5545 RRULE body, e.g. FREQ=DAILY (every day), FREQ=DAILY;INTERVAL=3 (every 3 days), FREQ=WEEKLY (every week), FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR (weekdays), FREQ=WEEKLY;BYDAY=SA,SU (weekends), FREQ=MONTHLY (every month). A rule OmniFocus cannot read is OmniFocusRepeatInvalid.'
const stored = 'Returns the task as OmniFocus stored it.'

export const OmniFocusToolkit = Toolkit.make(
  omnifocusTool(
    'omnifocus_list_perspectives',
    "List your OmniFocus custom perspectives. supported says whether omnifocus_perspective_tasks can work out a perspective's tasks; unsupportedReason says why not. Built-in perspectives such as Inbox and Forecast are not listed.",
    Tool.EmptyParams,
    Schema.Struct({ perspectives: Schema.Array(PerspectiveInfo) }),
    'reads',
  ),
  omnifocusTool(
    'omnifocus_perspective_tasks',
    "The tasks an OmniFocus custom perspective shows, worked out from the perspective's own filter rules over every remaining task. They come in OmniFocus database order (Inbox first), not the perspective's sort order, and without its grouping. A project the perspective matches is listed as a task whose project is itself. A perspective with a rule this server can't evaluate is OmniFocusPerspectiveUnsupported, naming the rule; omnifocus_list_perspectives shows which are supported.",
    Schema.Struct({
      perspective: TaskName.annotate({
        description:
          "The custom perspective's exact name, as omnifocus_list_perspectives lists it.",
      }),
    }),
    Schema.Struct({ perspective: Schema.String, tasks: Schema.Array(Task) }),
    'reads',
  ),
  omnifocusTool(
    'omnifocus_list_tags',
    'List your OmniFocus tags in OmniFocus order, each with its full path (parent first, e.g. Slot/Morning) and status. The OmniFocus task tools take a tag by path, or by a name only one tag has.',
    Tool.EmptyParams,
    TagList,
    'reads',
  ),
  omnifocusTool(
    'omnifocus_create_task',
    `Add a task to the OmniFocus Inbox, as Quick Entry does. ${dates} Tags must already exist; they are never created. ${repeats} ${stored}`,
    Schema.Struct({
      name: TaskName,
      note: Schema.optional(Schema.String),
      tags: Schema.optional(TagRefs),
      deferDate: Schema.optional(DeferDate),
      dueDate: Schema.optional(DueDate),
      repeat: Schema.optional(RepeatInput),
    }),
    TaskResult,
    'adds',
  ),
  omnifocusTool(
    'omnifocus_update_task',
    `Change one OmniFocus task. Fields you leave out stay as they are; null clears deferDate, dueDate or repeat. tags replaces all of the task's tags ([] removes them). repeat changes only the fields you give and keeps the rest of the existing rule; for a task that does not repeat yet it needs a rule. ${dates} ${repeats} ${stored}`,
    Schema.Struct({
      id: TaskId,
      name: Schema.optional(TaskName),
      note: Schema.optional(Schema.String),
      tags: Schema.optional(TagRefs),
      deferDate: Schema.optional(Schema.NullOr(DeferDate)),
      dueDate: Schema.optional(Schema.NullOr(DueDate)),
      repeat: Schema.optional(Schema.NullOr(RepeatChange)),
    }),
    TaskResult,
    'changes',
  ),
  omnifocusTool(
    'omnifocus_complete_task',
    "Complete the occurrence of an OmniFocus task that you last saw. Pass the deferDate a tool returned for it: if the task has moved on since (completed on another device, or by an earlier call), nothing changes and the result is OmniFocusOccurrenceMoved. That check only looks at deferDate, so it can't tell apart occurrences of a repeating task that has no defer date. Completing a completed task that does not repeat changes nothing.",
    Schema.Struct({
      id: TaskId,
      deferDate: SeenDeferDate,
      skip: Schema.optional(
        Schema.Boolean.annotate({
          description:
            'true drops just this occurrence of a repeating task instead of completing it, so the task moves on to its next occurrence. A task that does not repeat is OmniFocusNotRepeating.',
        }),
      ),
    }),
    CompleteResult,
    'changes',
  ),
)

const toTask = (t: Snapshot['tasks'][number]): Task => ({
  id: t.id,
  name: t.name,
  note: t.note,
  status: t.status,
  deferDate: t.deferDate,
  dueDate: t.dueDate,
  plannedDate: t.plannedDate,
  tags: t.tags,
  project: t.project,
  repeat: t.repeat,
})

export const OmniFocusToolkitLive = OmniFocusToolkit.toLayer(
  Effect.gen(function* () {
    const omnifocus = yield* OmniFocus
    const toFailure = Effect.mapError((e: OmniFocusError) => ({
      error: e._tag,
      message: e.message,
    }))

    const perspectiveTasks = Effect.fn('OmniFocus.perspectiveTasks')(function* (
      name: string,
    ) {
      const { tags, tasks, perspectives } = yield* omnifocus.evaluate(
        'snapshot',
        program(snapshot, {}),
        Snapshot,
      )
      const [perspective, ...others] = perspectives.filter(
        (p) => p.name === name,
      )
      if (perspective === undefined) {
        return yield* new OmniFocusPerspectiveNotFound({
          perspective: name,
          message: `No OmniFocus custom perspective is named "${name}". Built-in perspectives such as Forecast are not supported; omnifocus_list_perspectives lists the custom ones.`,
        })
      }
      if (others.length > 0) {
        return yield* new OmniFocusPerspectiveAmbiguous({
          perspective: name,
          message: `${others.length + 1} OmniFocus custom perspectives are named "${name}"; rename the extras in OmniFocus so the right one is used.`,
        })
      }
      const filter = parsePerspective(
        perspective.rules,
        perspective.aggregation,
      )
      if (Result.isFailure(filter)) {
        return yield* new OmniFocusPerspectiveUnsupported({
          perspective: name,
          reason: filter.failure,
          message: `The tasks of the OmniFocus perspective "${name}" can't be worked out here: ${filter.failure}.`,
        })
      }
      return {
        perspective: name,
        tasks: matchingTasks(filter.success, tags, tasks).map(toTask),
      }
    })

    return {
      omnifocus_list_perspectives: () =>
        omnifocus
          .evaluate(
            'list perspectives',
            program(listPerspectives, {}),
            PerspectiveList,
          )
          .pipe(
            Effect.map(({ perspectives }) => ({
              perspectives: perspectives.map(
                ({ id, name, rules, aggregation }) =>
                  Result.match(parsePerspective(rules, aggregation), {
                    onSuccess: () => ({ id, name, supported: true }),
                    onFailure: (reason) => ({
                      id,
                      name,
                      supported: false,
                      unsupportedReason: reason,
                    }),
                  }),
              ),
            })),
            toFailure,
          ),
      omnifocus_perspective_tasks: ({ perspective }) =>
        perspectiveTasks(perspective).pipe(toFailure),
      omnifocus_list_tags: () =>
        omnifocus
          .evaluate('list tags', program(listTags, {}), TagList)
          .pipe(toFailure),
      omnifocus_create_task: (p) =>
        omnifocus
          .evaluate('create task', program(createTask, p), TaskResult)
          .pipe(toFailure),
      omnifocus_update_task: (p) =>
        omnifocus
          .evaluate('update task', program(updateTask, p), TaskResult)
          .pipe(toFailure),
      omnifocus_complete_task: (p) =>
        omnifocus
          .evaluate('complete task', program(completeTask, p), CompleteResult)
          .pipe(toFailure),
    }
  }),
)

import type {
  CompleteTaskParams,
  CreateTaskParams,
  ScriptFailure,
  UpdateTaskParams,
} from './omnifocus-schema.ts'

// The OmniJS that runs inside OmniFocus. The scripts are TypeScript functions so that they are formatted, linted and
// type-checked like the rest of the server, and `program` sends them to OmniFocus as source text. They may use only
// their arguments and the OmniJS globals declared below: nothing else from this module exists inside OmniFocus.

// OmniJS enum values are opaque objects that print as "[object Task.Status: Available]".
interface Enum<Name extends string> {
  readonly __omnifocusEnum: Name
}
type ScheduleType = Enum<'Task.RepetitionScheduleType'>
type AnchorDateKey = Enum<'Task.AnchorDateKey'>
type ProjectStatus = Enum<'Project.Status'>

interface OFTag {
  readonly id: { readonly primaryKey: string }
  readonly name: string
  readonly parent: OFTag | null
  readonly status: Enum<'Tag.Status'>
}

interface OFFolder {
  readonly name: string
  readonly parent: OFFolder | null
}

interface OFProject {
  readonly id: { readonly primaryKey: string }
  readonly name: string
  readonly status: ProjectStatus
  readonly parentFolder: OFFolder | null
  readonly ending: unknown
}

interface OFRepetitionRule {
  readonly ruleString: string
  readonly scheduleType: ScheduleType
  readonly anchorDateKey: AnchorDateKey
  readonly catchUpAutomatically: boolean
}

interface OFTask {
  readonly id: { readonly primaryKey: string }
  name: string
  note: string
  readonly taskStatus: Enum<'Task.Status'>
  readonly completed: boolean
  deferDate: Date | null
  dueDate: Date | null
  readonly plannedDate: Date | null
  readonly effectiveDeferDate: Date | null
  readonly tags: ReadonlyArray<OFTag>
  readonly children: ReadonlyArray<OFTask>
  // For a project's own root task, the project itself.
  readonly containingProject: OFProject | null
  repetitionRule: OFRepetitionRule | null
  addTags(tags: ReadonlyArray<OFTag>): void
  removeTags(tags: ReadonlyArray<OFTag>): void
  // For a repeating task, completes a clone and returns it; the task itself moves on to its next occurrence.
  markComplete(): OFTask
  drop(allOccurrences: boolean): void
}

declare const Task: {
  new (name: string, position: unknown): OFTask
  byIdentifier(id: string): OFTask | null
  readonly Status: Readonly<
    Record<'Completed' | 'Dropped', Enum<'Task.Status'>>
  >
  // Throws on an invalid rule string. A null argument means OmniFocus's default.
  readonly RepetitionRule: new (
    ruleString: string,
    method: null,
    scheduleType: ScheduleType | null,
    anchorDateKey: AnchorDateKey | null,
    catchUpAutomatically: boolean | null,
  ) => OFRepetitionRule
  readonly RepetitionScheduleType: Readonly<
    Record<'Regularly' | 'FromCompletion', ScheduleType>
  >
  readonly AnchorDateKey: Readonly<
    Record<'DeferDate' | 'DueDate' | 'PlannedDate', AnchorDateKey>
  >
}
declare const Project: {
  readonly Status: Readonly<Record<'Done' | 'Dropped', ProjectStatus>>
}
declare const Perspective: {
  readonly Custom: {
    readonly all: ReadonlyArray<{
      readonly identifier: string
      readonly name: string
      readonly archivedFilterRules: unknown
      readonly archivedTopLevelFilterAggregation: unknown
    }>
  }
}
// Database order, inbox first.
declare const flattenedTasks: ReadonlyArray<OFTask>
declare const flattenedTags: ReadonlyArray<OFTag>
declare const flattenedProjects: ReadonlyArray<OFProject>
declare const inbox: { readonly ending: unknown }
declare const settings: { objectForKey(key: string): unknown }

// Helpers every script gets as its second argument.
const lib = () => {
  // A script refuses with fail(); `run` turns the refusal into the script's answer.
  class Refusal {
    constructor(readonly failure: ScriptFailure) {}
  }
  const fail = (_tag: ScriptFailure['_tag'], message: string): never => {
    throw new Refusal({ _tag, message })
  }

  const pad = (n: number) => String(n).padStart(2, '0')
  const local = (date: Date | null) =>
    date === null
      ? null
      : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  // A date-only value gets OmniFocus's own default time for that kind of date, stored like "06:00:00" or "17:00".
  const date = (
    value: string,
    defaultTimeKey: 'DefaultStartTime' | 'DefaultDueTime',
  ) => {
    const [day = '', time] = value.split(' ')
    const [y = NaN, mo = NaN, d = NaN] = day.split('-').map(Number)
    const setting = String(settings.objectForKey(defaultTimeKey))
    const [h = NaN, mi = NaN] = (time ?? setting).split(':').map(Number)
    if (!Number.isInteger(h) || !Number.isInteger(mi)) {
      throw new Error(
        `OmniFocus setting ${defaultTimeKey} is "${setting}", not a time of day`,
      )
    }
    return new Date(y, mo - 1, d, h, mi)
  }

  const enumName = (value: unknown) =>
    /: (\w+)\]$/.exec(String(value))?.[1] ?? String(value)
  const tagPath = (tag: OFTag) => {
    const names: Array<string> = []
    for (let at: OFTag | null = tag; at; at = at.parent) names.unshift(at.name)
    return names.join('/')
  }
  const projectPath = (project: OFProject) => {
    const names = [project.name]
    for (let at = project.parentFolder; at; at = at.parent)
      names.unshift(at.name)
    return names.join('/')
  }

  const schedules = {
    regularly: Task.RepetitionScheduleType.Regularly,
    fromCompletion: Task.RepetitionScheduleType.FromCompletion,
  }
  const anchors = {
    deferDate: Task.AnchorDateKey.DeferDate,
    dueDate: Task.AnchorDateKey.DueDate,
    plannedDate: Task.AnchorDateKey.PlannedDate,
  }
  const keyOf = (map: Record<string, unknown>, value: unknown) =>
    Object.entries(map).find(([, v]) => v === value)?.[0] ?? enumName(value)
  const repetitionRule = (
    ruleString: string,
    scheduleType: ScheduleType | null,
    anchorDateKey: AnchorDateKey | null,
    catchUp: boolean | null,
  ) => {
    try {
      return new Task.RepetitionRule(
        ruleString,
        null,
        scheduleType,
        anchorDateKey,
        catchUp,
      )
    } catch (e) {
      return fail(
        'OmniFocusRepeatInvalid',
        `OmniFocus rejected the repeat rule "${ruleString}": ${String(e)}`,
      )
    }
  }

  const task = (t: OFTask) => ({
    id: t.id.primaryKey,
    name: t.name,
    note: t.note,
    status: enumName(t.taskStatus),
    deferDate: local(t.deferDate),
    dueDate: local(t.dueDate),
    plannedDate: local(t.plannedDate),
    tags: t.tags.map(tagPath),
    project:
      t.containingProject === null ? null : projectPath(t.containingProject),
    repeat:
      t.repetitionRule === null
        ? null
        : {
            rule: t.repetitionRule.ruleString,
            schedule: keyOf(schedules, t.repetitionRule.scheduleType),
            anchor: keyOf(anchors, t.repetitionRule.anchorDateKey),
            catchUp: t.repetitionRule.catchUpAutomatically,
          },
  })
  const find = (id: string) =>
    Task.byIdentifier(id) ??
    fail('OmniFocusTaskNotFound', `No OmniFocus task has the id "${id}".`)

  // A full path wins over a name, so "Errands" is the top-level tag even if another tag is also named Errands.
  const tags = (refs: ReadonlyArray<string>) => {
    const all = flattenedTags.map((tag) => ({ tag, path: tagPath(tag) }))
    return refs.map((ref) => {
      const byPath = all.filter((t) => t.path === ref)
      const found =
        byPath.length > 0 ? byPath : all.filter((t) => t.tag.name === ref)
      const [only, ...others] = found
      if (only === undefined) {
        return fail(
          'OmniFocusTagNotFound',
          `No OmniFocus tag has the path or name "${ref}". Tags are never created; omnifocus_list_tags lists them. Nothing changed.`,
        )
      }
      if (others.length > 0) {
        return fail(
          'OmniFocusTagAmbiguous',
          `"${ref}" could be any of ${found.map((t) => JSON.stringify(t.path)).join(', ')}; give the full path. Nothing changed.`,
        )
      }
      return only.tag
    })
  }

  // Like a tag, a full path wins over a name. A task added to a completed project reopens it and one added to a dropped
  // project is dropped too (measured on OmniFocus 4.9.3), so neither takes new tasks here.
  const project = (ref: string) => {
    const all = flattenedProjects.map((p) => ({
      project: p,
      path: projectPath(p),
    }))
    const byPath = all.filter((p) => p.path === ref)
    const found =
      byPath.length > 0 ? byPath : all.filter((p) => p.project.name === ref)
    const [only, ...others] = found
    if (only === undefined) {
      return fail(
        'OmniFocusProjectNotFound',
        `No OmniFocus project has the path or name "${ref}". Projects are never created; omnifocus_list_projects lists them. Nothing changed.`,
      )
    }
    if (others.length > 0) {
      return fail(
        'OmniFocusProjectAmbiguous',
        `"${ref}" could be any of ${found.map((p) => JSON.stringify(p.path)).join(', ')}; give the full path. Nothing changed.`,
      )
    }
    if (only.project.status === Project.Status.Done) {
      return fail(
        'OmniFocusProjectClosed',
        `The OmniFocus project "${only.path}" is completed, and adding a task to it would reopen it. Reactivate it in OmniFocus first if you mean to. Nothing changed.`,
      )
    }
    if (only.project.status === Project.Status.Dropped) {
      return fail(
        'OmniFocusProjectClosed',
        `The OmniFocus project "${only.path}" is dropped, so a task added to it would be dropped already. Reactivate it in OmniFocus first if you mean to. Nothing changed.`,
      )
    }
    return only.project
  }

  // What the perspective rules need to know about tags.
  const tagTree = () =>
    flattenedTags.map((t) => ({
      id: t.id.primaryKey,
      name: t.name,
      parentId: t.parent?.id.primaryKey ?? null,
    }))
  const perspectives = () =>
    Perspective.Custom.all.map((p) => ({
      id: p.identifier,
      name: p.name,
      rules: p.archivedFilterRules ?? null,
      aggregation: p.archivedTopLevelFilterAggregation ?? null,
    }))

  return {
    Refusal,
    fail,
    local,
    date,
    enumName,
    tagPath,
    projectPath,
    schedules,
    anchors,
    repetitionRule,
    task,
    find,
    tags,
    project,
    tagTree,
    perspectives,
  }
}

type Lib = ReturnType<typeof lib>
type Script<A> = (args: A, omni: Lib) => unknown
type NoArgs = Record<string, never>

const run = <A>(makeLib: () => Lib, script: Script<A>, args: A) => {
  const omni = makeLib()
  try {
    return JSON.stringify(script(args, omni))
  } catch (e) {
    if (e instanceof omni.Refusal) return JSON.stringify(e.failure)
    throw e
  }
}

// The OmniJS source for one call. The arguments travel only as the JSON literal on the second-to-last line.
export const program = <A>(script: Script<A>, args: A) =>
  `(${run.toString()})(${lib.toString()}, ${script.toString()},\n${JSON.stringify(args)}\n)`

export const listPerspectives: Script<NoArgs> = (_, omni) => ({
  tags: omni.tagTree(),
  perspectives: omni.perspectives(),
})

export const snapshot: Script<NoArgs> = (_, omni) => {
  const { Completed, Dropped } = Task.Status
  return {
    tags: omni.tagTree(),
    tasks: flattenedTasks
      .filter((t) => t.taskStatus !== Completed && t.taskStatus !== Dropped)
      .map((t) => ({
        ...omni.task(t),
        tagIds: t.tags.map((tag) => tag.id.primaryKey),
        leaf: t.children.length === 0,
        effectiveDeferDate: omni.local(t.effectiveDeferDate),
      })),
    perspectives: omni.perspectives(),
  }
}

export const listTags: Script<NoArgs> = (_, omni) => ({
  tags: flattenedTags.map((t) => ({
    id: t.id.primaryKey,
    name: t.name,
    path: omni.tagPath(t),
    status: omni.enumName(t.status),
  })),
})

// Into the Inbox, as Quick Entry does. Everything that can be refused is checked before the task exists.
export const createTask: Script<CreateTaskParams> = (args, omni) => {
  const tags = omni.tags(args.tags ?? [])
  const deferDate =
    args.deferDate === undefined
      ? null
      : omni.date(args.deferDate, 'DefaultStartTime')
  const dueDate =
    args.dueDate === undefined
      ? null
      : omni.date(args.dueDate, 'DefaultDueTime')
  const repeat = args.repeat
  const rule =
    repeat === undefined
      ? null
      : omni.repetitionRule(
          repeat.rule,
          repeat.schedule === undefined
            ? null
            : omni.schedules[repeat.schedule],
          repeat.anchor === undefined ? null : omni.anchors[repeat.anchor],
          repeat.catchUp ?? null,
        )

  const task = new Task(args.name, inbox.ending)
  if (args.note !== undefined) task.note = args.note
  task.addTags(tags)
  task.deferDate = deferDate
  task.dueDate = dueDate
  if (rule !== null) task.repetitionRule = rule
  return { task: omni.task(task) }
}

// An omitted field is left alone and a field named in `clear` is removed. Everything that can be refused is checked
// before anything changes.
export const updateTask: Script<UpdateTaskParams> = (args, omni) => {
  const task = omni.find(args.id)
  const clear = args.clear ?? []
  for (const field of clear) {
    if (args[field] !== undefined) {
      omni.fail(
        'OmniFocusUpdateConflict',
        `${field} is both given and cleared. Nothing changed.`,
      )
    }
  }
  const tags = args.tags === undefined ? undefined : omni.tags(args.tags)
  const deferDate = clear.includes('deferDate')
    ? null
    : args.deferDate === undefined
      ? undefined
      : omni.date(args.deferDate, 'DefaultStartTime')
  const dueDate = clear.includes('dueDate')
    ? null
    : args.dueDate === undefined
      ? undefined
      : omni.date(args.dueDate, 'DefaultDueTime')

  // A rule can't be edited in place, so a partial change is rebuilt on the fields of the existing rule.
  let rule: OFRepetitionRule | null | undefined
  if (clear.includes('repeat')) rule = null
  else if (args.repeat !== undefined) {
    const change = args.repeat
    const old = task.repetitionRule
    const ruleString =
      change.rule ??
      old?.ruleString ??
      omni.fail(
        'OmniFocusRepeatInvalid',
        `"${task.name}" does not repeat yet, so repeat needs a rule. Nothing changed.`,
      )
    rule = omni.repetitionRule(
      ruleString,
      change.schedule === undefined
        ? (old?.scheduleType ?? null)
        : omni.schedules[change.schedule],
      change.anchor === undefined
        ? (old?.anchorDateKey ?? null)
        : omni.anchors[change.anchor],
      change.catchUp ?? old?.catchUpAutomatically ?? null,
    )
  }

  if (args.name !== undefined) task.name = args.name
  if (args.note !== undefined) task.note = args.note
  if (tags !== undefined) {
    task.removeTags(task.tags)
    task.addTags(tags)
  }
  if (deferDate !== undefined) task.deferDate = deferDate
  if (dueDate !== undefined) task.dueDate = dueDate
  if (rule !== undefined) task.repetitionRule = rule
  return { task: omni.task(task) }
}

// Completing a repeating task twice moves it on twice (measured on OmniFocus 4.9.3), so the caller says which
// occurrence it means by the deferDate it saw, and a task that has moved on since is left alone.
export const completeTask: Script<CompleteTaskParams> = (args, omni) => {
  const task = omni.find(args.id)
  const current = omni.local(task.deferDate)
  if (current !== args.deferDate) {
    return omni.fail(
      'OmniFocusOccurrenceMoved',
      `"${task.name}" is now deferred to ${current ?? 'no date'}, not ${args.deferDate ?? 'no date'}, so the occurrence you saw was probably already completed. Nothing changed; read the task again before completing it.`,
    )
  }
  const { Dropped } = Task.Status

  if (args.skip === true) {
    if (task.repetitionRule === null) {
      return omni.fail(
        'OmniFocusNotRepeating',
        `"${task.name}" does not repeat, so it has no occurrence to skip. Nothing changed.`,
      )
    }
    const before = new Set(flattenedTasks.map((t) => t.id.primaryKey))
    task.drop(false)
    const dropped =
      flattenedTasks.find((t) => !before.has(t.id.primaryKey)) ??
      (task.taskStatus === Dropped ? task : null)
    return {
      completed: dropped === null ? null : omni.task(dropped),
      next: task.taskStatus === Dropped ? null : omni.task(task),
    }
  }

  if (task.completed && task.repetitionRule === null) {
    return { completed: omni.task(task), next: null }
  }
  const done = task.markComplete()
  return {
    completed: omni.task(done),
    next: done.id.primaryKey === task.id.primaryKey ? null : omni.task(task),
  }
}

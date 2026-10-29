import type {
  CompleteTasksParams,
  CreateProjectParams,
  CreateTagParams,
  CreateTaskParams,
  FindTasksParams,
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
  readonly children: ReadonlyArray<OFTag>
  readonly status: Enum<'Tag.Status'>
}

interface OFFolder {
  readonly id: { readonly primaryKey: string }
  readonly name: string
  readonly parent: OFFolder | null
}

interface OFProject {
  readonly id: { readonly primaryKey: string }
  readonly name: string
  note: string
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
  // For a task directly in a project, the project's root task.
  readonly parent: OFTask | null
  // For a project's own root task, the project itself.
  readonly containingProject: OFProject | null
  // Only on a project's own root task, which shares the project's id.
  readonly project: OFProject | null
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
// A null position is the top level.
declare const Tag: new (name: string, position: OFTag | null) => OFTag
declare const Project: {
  new (name: string, position: OFFolder | null): OFProject
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
declare const flattenedFolders: ReadonlyArray<OFFolder>
// Top-level tags.
declare const tags: ReadonlyArray<OFTag>
declare const inbox: { readonly ending: unknown }
declare const moveTasks: (
  tasks: ReadonlyArray<OFTask>,
  position: unknown,
) => void
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
  const folderPath = (folder: OFFolder) => {
    const names: Array<string> = []
    for (let at: OFFolder | null = folder; at; at = at.parent)
      names.unshift(at.name)
    return names.join('/')
  }
  const projectPath = (project: OFProject) =>
    project.parentFolder === null
      ? project.name
      : `${folderPath(project.parentFolder)}/${project.name}`
  const tagInfo = (t: OFTag) => ({
    id: t.id.primaryKey,
    name: t.name,
    path: tagPath(t),
    status: enumName(t.status),
  })
  const projectInfo = (p: OFProject) => ({
    id: p.id.primaryKey,
    name: p.name,
    path: projectPath(p),
    status: enumName(p.status),
  })

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

  // What the first test that matches anything matches.
  const firstMatch = <T>(
    all: ReadonlyArray<T>,
    ...tests: ReadonlyArray<(item: T) => boolean>
  ) => {
    for (const test of tests) {
      const found = all.filter(test)
      if (found.length > 0) return found
    }
    return []
  }

  // An id wins over a full path, and a full path over a name, so "Errands" is the top-level tag even if another tag is
  // also named Errands.
  const tags = (refs: ReadonlyArray<string>) => {
    const all = flattenedTags.map((tag) => ({ tag, path: tagPath(tag) }))
    return refs.map((ref) => {
      const found = firstMatch(
        all,
        (t) => t.tag.id.primaryKey === ref,
        (t) => t.path === ref,
        (t) => t.tag.name === ref,
      )
      const [only, ...others] = found
      if (only === undefined) {
        return fail(
          'OmniFocusTagNotFound',
          `No OmniFocus tag has the id, path or name "${ref}". omnifocus_list_tags lists them, and omnifocus_create_tag makes a new one. Nothing changed.`,
        )
      }
      if (others.length > 0) {
        return fail(
          'OmniFocusTagAmbiguous',
          `"${ref}" could be any of ${found.map((t) => `${JSON.stringify(t.path)} (id ${t.tag.id.primaryKey})`).join(', ')}; give the full path or the id. Nothing changed.`,
        )
      }
      return only.tag
    })
  }

  // Looked up like a tag. A task added to a completed project reopens it and one added to a dropped project is dropped
  // too (measured on OmniFocus 4.9.3), so neither takes new tasks here. That also keeps an old completed project from
  // making an open one of the same path ambiguous.
  const project = (ref: string) => {
    const all = flattenedProjects.map((p) => ({
      project: p,
      path: projectPath(p),
      closed:
        p.status === Project.Status.Done
          ? 'completed, and adding a task to it would reopen it'
          : p.status === Project.Status.Dropped
            ? 'dropped, so a task added to it would be dropped already'
            : null,
    }))
    const found = firstMatch(
      all,
      (p) => p.project.id.primaryKey === ref,
      (p) => p.path === ref,
      (p) => p.project.name === ref,
    )
    const open = found.filter((p) => p.closed === null)
    const [only, ...others] = open
    if (found.length === 0) {
      return fail(
        'OmniFocusProjectNotFound',
        `No OmniFocus project has the id, path or name "${ref}". omnifocus_list_projects lists them, and omnifocus_create_project makes a new one. Nothing changed.`,
      )
    }
    if (only === undefined) {
      return fail(
        'OmniFocusProjectClosed',
        `${found.map((p) => `The OmniFocus project "${p.path}" is ${p.closed}.`).join(' ')} Reactivate it in OmniFocus first if you mean to. Nothing changed.`,
      )
    }
    if (others.length > 0) {
      return fail(
        'OmniFocusProjectAmbiguous',
        `"${ref}" could be any of ${open.map((p) => `${JSON.stringify(p.path)} (id ${p.project.id.primaryKey})`).join(', ')}; give the full path or the id. Nothing changed.`,
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
    folderPath,
    projectPath,
    tagInfo,
    projectInfo,
    schedules,
    anchors,
    repetitionRule,
    task,
    find,
    firstMatch,
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
  tags: flattenedTags.map(omni.tagInfo),
})

export const listProjects: Script<NoArgs> = (_, omni) => ({
  projects: flattenedProjects.map(omni.projectInfo),
})

// A tag already in the same place with the same name is returned as it is, so a retry makes no second one.
export const createTag: Script<CreateTagParams> = (args, omni) => {
  const [parent = null] =
    args.parent === undefined ? [] : omni.tags([args.parent])
  const existing = (parent === null ? tags : parent.children).find(
    (t) => t.name === args.name,
  )
  if (existing !== undefined) {
    return { tag: omni.tagInfo(existing), created: false }
  }
  return { tag: omni.tagInfo(new Tag(args.name, parent)), created: true }
}

// An open project already in the same folder with the same name is returned as it is, so a retry makes no second one. A
// completed or dropped one doesn't count, since it takes no tasks here.
export const createProject: Script<CreateProjectParams> = (args, omni) => {
  const ref = args.folder
  let folder: OFFolder | null = null
  if (ref !== undefined) {
    const found = omni.firstMatch(
      flattenedFolders,
      (f) => f.id.primaryKey === ref,
      (f) => omni.folderPath(f) === ref,
      (f) => f.name === ref,
    )
    const [only, ...others] = found
    if (only === undefined) {
      return omni.fail(
        'OmniFocusFolderNotFound',
        `No OmniFocus folder has the id, path or name "${ref}". Folders are never created. Nothing changed.`,
      )
    }
    if (others.length > 0) {
      return omni.fail(
        'OmniFocusFolderAmbiguous',
        `"${ref}" could be any of ${found.map((f) => `${JSON.stringify(omni.folderPath(f))} (id ${f.id.primaryKey})`).join(', ')}; give the full path or the id. Nothing changed.`,
      )
    }
    folder = only
  }
  const { Done, Dropped } = Project.Status
  const existing = flattenedProjects.find(
    (p) =>
      p.name === args.name &&
      (p.parentFolder?.id.primaryKey ?? null) ===
        (folder?.id.primaryKey ?? null) &&
      p.status !== Done &&
      p.status !== Dropped,
  )
  if (existing !== undefined) {
    return { project: omni.projectInfo(existing), created: false }
  }
  const project = new Project(args.name, folder)
  if (args.note !== undefined) project.note = args.note
  return { project: omni.projectInfo(project), created: true }
}

// A search, so a project or tag matches every project or tag it could name by path or name, closed ones included, and
// a tag also matches the tags nested under it, as OmniFocus's own tag rules do.
export const findTasks: Script<FindTasksParams & { limit: number }> = (
  args,
  omni,
) => {
  const ids = (found: ReadonlyArray<{ id: { primaryKey: string } }>) =>
    new Set(found.map((item) => item.id.primaryKey))
  const projectRef = args.project
  const projectIds =
    projectRef === undefined
      ? null
      : ids(
          omni.firstMatch(
            flattenedProjects,
            (p) => p.id.primaryKey === projectRef,
            (p) => omni.projectPath(p) === projectRef || p.name === projectRef,
          ),
        )
  if (projectIds?.size === 0) {
    omni.fail(
      'OmniFocusProjectNotFound',
      `No OmniFocus project has the id, path or name "${projectRef}"; omnifocus_list_projects lists them.`,
    )
  }
  const tagRef = args.tag
  const tagIds =
    tagRef === undefined
      ? null
      : ids(
          omni.firstMatch(
            flattenedTags,
            (t) => t.id.primaryKey === tagRef,
            (t) => omni.tagPath(t) === tagRef || t.name === tagRef,
          ),
        )
  if (tagIds?.size === 0) {
    omni.fail(
      'OmniFocusTagNotFound',
      `No OmniFocus tag has the id, path or name "${tagRef}"; omnifocus_list_tags lists them.`,
    )
  }
  const tagged = (tag: OFTag) => {
    for (let at: OFTag | null = tag; at; at = at.parent) {
      if (tagIds?.has(at.id.primaryKey)) return true
    }
    return false
  }

  const text = args.text?.toLowerCase()
  const { Completed, Dropped } = Task.Status
  const found = flattenedTasks.filter(
    (t) =>
      (args.includeClosed === true ||
        (t.taskStatus !== Completed && t.taskStatus !== Dropped)) &&
      (text === undefined || t.name.toLowerCase().includes(text)) &&
      (projectIds === null ||
        (t.containingProject !== null &&
          projectIds.has(t.containingProject.id.primaryKey))) &&
      (tagIds === null || t.tags.some(tagged)),
  )
  return {
    tasks: found.slice(0, args.limit).map(omni.task),
    omitted: Math.max(0, found.length - args.limit),
  }
}

// To the end of the project, or into the Inbox as Quick Entry does. Everything that can be refused is checked before the
// task exists.
export const createTask: Script<CreateTaskParams> = (args, omni) => {
  const project = args.project === undefined ? null : omni.project(args.project)
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

  const task = new Task(
    args.name,
    project === null ? inbox.ending : project.ending,
  )
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
  // Moving a project's root task would turn the whole project into a task.
  if (
    task.project !== null &&
    (args.project !== undefined || clear.includes('project'))
  ) {
    omni.fail(
      'OmniFocusTaskIsProject',
      `"${task.name}" is the project "${omni.projectPath(task.project)}" itself, not a task in it, so it can't be moved. Nothing changed.`,
    )
  }
  // null moves the task to the Inbox. A task already in the project, or already in the Inbox, is not moved, so it keeps
  // its place there.
  const project = clear.includes('project')
    ? null
    : args.project === undefined
      ? undefined
      : omni.project(args.project)
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
  if (project === null) {
    if (task.containingProject !== null) moveTasks([task], inbox.ending)
  } else if (
    project !== undefined &&
    task.containingProject?.id.primaryKey !== project.id.primaryKey
  ) {
    moveTasks([task], project.ending)
  }
  if (tags !== undefined) {
    task.removeTags(task.tags)
    task.addTags(tags)
  }
  if (deferDate !== undefined) task.deferDate = deferDate
  if (dueDate !== undefined) task.dueDate = dueDate
  if (rule !== undefined) task.repetitionRule = rule
  return { task: omni.task(task) }
}

// Completing a repeating task twice moves it on twice (measured on OmniFocus 4.9.3), so for a repeating task the caller
// says which occurrence it saw by its deferDate. Every task is checked before any changes, so a refused batch changes
// nothing, and the refusal names every task that can't be completed.
export const completeTasks: Script<CompleteTasksParams> = (args, omni) => {
  // Completing the last task inside a group or project can complete that too (measured on OmniFocus 4.9.3), so a
  // repeating one listed with a task inside it would move on twice.
  const ids = args.tasks.map((item) => item.id)
  const check = (item: CompleteTasksParams['tasks'][number], at: number) => {
    if (ids.indexOf(item.id) !== at) {
      omni.fail(
        'OmniFocusTasksOverlap',
        `The task "${item.id}" is listed more than once; completing a repeating task twice would move it on twice.`,
      )
    }
    const task = omni.find(item.id)
    for (let up = task.parent; up; up = up.parent) {
      if (ids.includes(up.id.primaryKey)) {
        omni.fail(
          'OmniFocusTasksOverlap',
          `"${task.name}" is inside "${up.name}", which is also listed, and completing it can complete "${up.name}" too. Complete "${up.name}" in a separate call if it is still open after.`,
        )
      }
    }
    const current = omni.local(task.deferDate)
    if (item.deferDate === undefined && task.repetitionRule !== null) {
      omni.fail(
        'OmniFocusOccurrenceRequired',
        `"${task.name}" repeats, so give the deferDate you saw for it: ${current === null ? 'null' : current} if you mean the occurrence it is on now.`,
      )
    }
    if (item.deferDate !== undefined && item.deferDate !== current) {
      omni.fail(
        'OmniFocusOccurrenceMoved',
        `"${task.name}" is now deferred to ${current ?? 'no date'}, not ${item.deferDate ?? 'no date'}, so the occurrence you saw was probably already completed; read the task again before completing it.`,
      )
    }
    if (item.skip === true && task.repetitionRule === null) {
      omni.fail(
        'OmniFocusNotRepeating',
        `"${task.name}" does not repeat, so it has no occurrence to skip.`,
      )
    }
    return task
  }

  const problems: Array<ScriptFailure> = []
  const checked = args.tasks.flatMap((item, at) => {
    try {
      return [{ item, task: check(item, at) }]
    } catch (e) {
      if (!(e instanceof omni.Refusal)) throw e
      problems.push(e.failure)
      return []
    }
  })
  const [first] = problems
  if (first !== undefined) {
    return omni.fail(
      first._tag,
      problems.length === 1
        ? `${first.message} Nothing changed.`
        : `${problems.length} of the ${args.tasks.length} tasks can't be completed, so nothing changed. ${problems.map((p) => `${p._tag}: ${p.message}`).join(' ')}`,
    )
  }

  const { Dropped } = Task.Status
  const complete = (task: OFTask, skip: boolean) => {
    if (skip) {
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
  return {
    results: checked.map(({ item, task }) => ({
      id: item.id,
      ...complete(task, item.skip === true),
    })),
  }
}

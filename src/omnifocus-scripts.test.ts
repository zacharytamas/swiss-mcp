import { beforeEach, describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import type {
  CompleteTasksParams,
  FindTasksParams,
} from './omnifocus-schema.ts'
import {
  completeTasks,
  createProject,
  createTag,
  createTask,
  findTasks,
  listProjects,
  listTags,
  program,
  snapshot,
  updateTask,
} from './omnifocus-scripts.ts'

// A stand-in for the slice of OmniJS the scripts use, written from Omni's API reference and what was measured on
// OmniFocus 4.9.3: a completed or dropped occurrence of a repeating task is a clone, and the task itself moves on a
// day. The programs run in a fresh VM context, so anything they reference besides these globals fails.
const enumValue = (type: string, name: string) => ({
  toString: () => `[object ${type}: ${name}]`,
})
const Status = {
  Available: enumValue('Task.Status', 'Available'),
  Next: enumValue('Task.Status', 'Next'),
  Completed: enumValue('Task.Status', 'Completed'),
  Dropped: enumValue('Task.Status', 'Dropped'),
}
const Schedule = {
  Regularly: enumValue('Task.RepetitionScheduleType', 'Regularly'),
  FromCompletion: enumValue('Task.RepetitionScheduleType', 'FromCompletion'),
}
const Anchor = {
  DeferDate: enumValue('Task.AnchorDateKey', 'DeferDate'),
  DueDate: enumValue('Task.AnchorDateKey', 'DueDate'),
  PlannedDate: enumValue('Task.AnchorDateKey', 'PlannedDate'),
}

interface FakeTag {
  id: { primaryKey: string }
  name: string
  parent: FakeTag | null
  readonly children: ReadonlyArray<FakeTag>
  status: object
}
const tag = (
  id: string,
  name: string,
  parent: FakeTag | null = null,
): FakeTag => ({
  id: { primaryKey: id },
  name,
  parent,
  get children() {
    return tags.filter((t) => t.parent === this)
  },
  status: enumValue('Tag.Status', 'Active'),
})

const ProjectStatus = {
  Active: enumValue('Project.Status', 'Active'),
  OnHold: enumValue('Project.Status', 'OnHold'),
  Done: enumValue('Project.Status', 'Done'),
  Dropped: enumValue('Project.Status', 'Dropped'),
}

interface FakeFolder {
  id: { primaryKey: string }
  name: string
  parent: FakeFolder | null
}
const folder = (
  id: string,
  name: string,
  parent: FakeFolder | null = null,
) => ({
  id: { primaryKey: id },
  name,
  parent,
})
interface FakeProject {
  id: { primaryKey: string }
  name: string
  note: string
  status: object
  parentFolder: FakeFolder | null
  ending: string
}
const project = (
  id: string,
  name: string,
  parentFolder: FakeFolder | null = null,
  status: object = ProjectStatus.Active,
) => ({
  id: { primaryKey: id },
  name,
  note: '',
  status,
  parentFolder,
  ending: `${id}.ending`,
})

let tasks: Array<FakeTask> = []
let tags: Array<FakeTag> = []
let projects: Array<FakeProject> = []
let folders: Array<FakeFolder> = []
let moves: Array<[ReadonlyArray<string>, unknown]> = []
let ruleCalls: Array<ReadonlyArray<unknown>> = []
let nextId = 1

class FakeRule {
  readonly ruleString: string
  readonly scheduleType: object
  readonly anchorDateKey: object
  readonly catchUpAutomatically: boolean
  constructor(
    ruleString: string,
    method: null,
    scheduleType: object | null,
    anchorDateKey: object | null,
    catchUp: boolean | null,
  ) {
    ruleCalls.push([ruleString, method, scheduleType, anchorDateKey, catchUp])
    if (!ruleString.startsWith('FREQ=')) throw new Error('Unknown rule')
    this.ruleString = ruleString
    this.scheduleType = scheduleType ?? Schedule.Regularly
    this.anchorDateKey = anchorDateKey ?? Anchor.DueDate
    this.catchUpAutomatically = catchUp ?? false
  }
}

const nextDay = (date: Date | null) =>
  date && new Date(date.getTime() + 24 * 60 * 60 * 1000)

class FakeTask {
  id = { primaryKey: `task-${nextId++}` }
  note = ''
  taskStatus = Status.Available
  completed = false
  deferDate: Date | null = null
  dueDate: Date | null = null
  plannedDate: Date | null = null
  tags: Array<FakeTag> = []
  children: Array<FakeTask> = []
  parent: FakeTask | null = null
  containingProject: FakeProject | null = null
  project: FakeProject | null = null
  repetitionRule: FakeRule | null = null
  constructor(
    public name: string,
    public position?: unknown,
  ) {
    this.containingProject = projects.find((p) => p.ending === position) ?? null
    tasks.push(this)
  }
  get effectiveDeferDate() {
    return this.deferDate
  }
  addTags(more: ReadonlyArray<FakeTag>) {
    this.tags = [...this.tags, ...more.filter((t) => !this.tags.includes(t))]
  }
  removeTags(less: ReadonlyArray<FakeTag>) {
    this.tags = this.tags.filter((t) => !less.includes(t))
  }
  private resolve(status: object, completed: boolean) {
    if (this.repetitionRule === null) {
      this.taskStatus = status
      this.completed = completed
      return this
    }
    const clone = Object.assign(new FakeTask(this.name), {
      note: this.note,
      deferDate: this.deferDate,
      dueDate: this.dueDate,
      tags: this.tags,
      repetitionRule: this.repetitionRule,
      taskStatus: status,
      completed,
    })
    this.deferDate = nextDay(this.deferDate)
    this.dueDate = nextDay(this.dueDate)
    return clone
  }
  markComplete() {
    return this.resolve(Status.Completed, true)
  }
  drop(allOccurrences: boolean) {
    if (allOccurrences) this.repetitionRule = null
    this.resolve(Status.Dropped, false)
  }
}

const globals = () => ({
  Task: Object.assign(
    function (name: string, position: unknown) {
      return new FakeTask(name, position)
    },
    {
      byIdentifier: (id: string) =>
        tasks.find((t) => t.id.primaryKey === id) ?? null,
      Status,
      RepetitionRule: FakeRule,
      RepetitionScheduleType: Schedule,
      AnchorDateKey: Anchor,
    },
  ),
  Tag: function (name: string, parent: FakeTag | null) {
    const made = tag(`tag-${nextId++}`, name, parent)
    tags.push(made)
    return made
  },
  Project: Object.assign(
    function (name: string, parentFolder: FakeFolder | null) {
      const made = project(`project-${nextId++}`, name, parentFolder)
      projects.push(made)
      return made
    },
    { Status: ProjectStatus },
  ),
  Perspective: { Custom: { all: [] } },
  get flattenedTasks() {
    return [...tasks]
  },
  get flattenedTags() {
    return [...tags]
  },
  get flattenedProjects() {
    return [...projects]
  },
  get flattenedFolders() {
    return [...folders]
  },
  get tags() {
    return tags.filter((t) => t.parent === null)
  },
  inbox: { ending: 'inbox.ending' },
  moveTasks: (moved: ReadonlyArray<FakeTask>, position: unknown) => {
    moves.push([moved.map((t) => t.id.primaryKey), position])
    for (const t of moved) {
      t.containingProject = projects.find((p) => p.ending === position) ?? null
    }
  },
  settings: {
    objectForKey: (key: string) =>
      ({ DefaultStartTime: '06:00:00', DefaultDueTime: '17:00' })[key],
  },
})

const evaluate = <A>(script: Parameters<typeof program<A>>[0], args: A) =>
  JSON.parse(runInNewContext(program(script, args), globals()) as string)

const local = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi)

let slot: FakeTag
let morning: FakeTag
let housekeeping: FakeProject
beforeEach(() => {
  tasks = []
  ruleCalls = []
  moves = []
  slot = tag('slot', 'Slot')
  morning = tag('morning', 'Morning', slot)
  // Two tags named Errands: the top-level one is also a full path.
  tags = [
    slot,
    morning,
    tag('home', 'Home'),
    tag('errands', 'Errands'),
    tag('slot-errands', 'Errands', slot),
    tag('evening', 'Evening', slot),
    tag('evening2', 'Evening', tag('work', 'Work')),
  ]
  const domestic = folder('domestic', 'Domestic')
  const home = folder('home', 'Home')
  const work = folder('work', 'Work')
  // Two folders named Lists.
  folders = [
    domestic,
    home,
    work,
    folder('home-lists', 'Lists', home),
    folder('work-lists', 'Lists', work),
  ]
  housekeeping = project('housekeeping', 'Housekeeping', domestic)
  // Two projects named Garden: the top-level one is also a full path.
  projects = [
    housekeeping,
    project('garden', 'Garden'),
    project('domestic-garden', 'Garden', domestic),
    project('home-shopping', 'Shopping', home),
    project('work-shopping', 'Shopping', work),
    project('bikes', 'Bikes', null, ProjectStatus.OnHold),
    project('taxes', 'Taxes', null, ProjectStatus.Done),
    project('cello', 'Cello', null, ProjectStatus.Dropped),
    // An old completed Reading and the open one share a path.
    project('reading-2025', 'Reading', null, ProjectStatus.Done),
    project('reading', 'Reading'),
    project('old-cello', 'Cello', null, ProjectStatus.Done),
  ]
})

const strange = `Call "Dad" about Zoë's \\ backslash\nsecond line 🎉`

describe('createTask', () => {
  test('creates an Inbox task with the exact name, OmniFocus default times for dates alone, and tags by path or name', () => {
    const { task } = evaluate(createTask, {
      name: strange,
      note: 'a note',
      tags: ['Slot/Morning', 'Home', 'Errands'],
      deferDate: '2026-10-27',
      dueDate: '2026-10-28 09:30',
    })

    expect(task).toEqual({
      id: 'task-1',
      name: strange,
      note: 'a note',
      status: 'Available',
      deferDate: '2026-10-27 06:00',
      dueDate: '2026-10-28 09:30',
      plannedDate: null,
      tags: ['Slot/Morning', 'Home', 'Errands'],
      project: null,
      repeat: null,
    })
    expect(tasks[0]?.position).toBe('inbox.ending')
  })

  test.each([
    ['Domestic/Housekeeping', 'housekeeping', 'Domestic/Housekeeping'],
    ['Housekeeping', 'housekeeping', 'Domestic/Housekeeping'],
    ['Garden', 'garden', 'Garden'],
    // On hold, which still takes tasks.
    ['Bikes', 'bikes', 'Bikes'],
    ['Reading', 'reading', 'Reading'],
    // By id, which also tells apart projects a name or path can't.
    ['work-shopping', 'work-shopping', 'Work/Shopping'],
  ])('creates at the end of the project %s', (ref, id, path) => {
    const { task } = evaluate(createTask, { name: 'x', project: ref })

    expect(task.project).toBe(path)
    expect(tasks[0]?.position).toBe(`${id}.ending`)
  })

  test.each([
    ['evening2', 'Work/Evening'],
    ['morning', 'Slot/Morning'],
  ])('takes the tag %s by id', (ref, path) => {
    const { task } = evaluate(createTask, { name: 'x', tags: [ref] })

    expect(task.tags).toEqual([path])
  })

  test('a date alone for dueDate takes the default due time', () => {
    const { task } = evaluate(createTask, { name: 'x', dueDate: '2026-10-28' })

    expect(task.dueDate).toBe('2026-10-28 17:00')
  })

  test('passes null for every repeat field that is left out, so OmniFocus applies its defaults', () => {
    const { task } = evaluate(createTask, {
      name: 'x',
      repeat: { rule: 'FREQ=DAILY' },
    })

    expect(ruleCalls).toEqual([['FREQ=DAILY', null, null, null, null]])
    expect(task.repeat).toEqual({
      rule: 'FREQ=DAILY',
      schedule: 'regularly',
      anchor: 'dueDate',
      catchUp: false,
    })
  })

  test('passes the repeat fields that are given as OmniFocus values', () => {
    evaluate(createTask, {
      name: 'x',
      repeat: {
        rule: 'FREQ=WEEKLY;BYDAY=SA,SU',
        schedule: 'fromCompletion',
        anchor: 'deferDate',
        catchUp: true,
      },
    })

    expect(ruleCalls).toEqual([
      [
        'FREQ=WEEKLY;BYDAY=SA,SU',
        null,
        Schedule.FromCompletion,
        Anchor.DeferDate,
        true,
      ],
    ])
  })

  test.each([
    [{ tags: ['Nope'] }, 'OmniFocusTagNotFound', '"Nope"'],
    [
      { tags: ['Evening'] },
      'OmniFocusTagAmbiguous',
      '"Slot/Evening" (id evening), "Work/Evening" (id evening2); give the full path or the id',
    ],
    [
      { repeat: { rule: 'EVERY DAY' } },
      'OmniFocusRepeatInvalid',
      'Unknown rule',
    ],
    [{ project: 'Nope' }, 'OmniFocusProjectNotFound', '"Nope"'],
    [
      { project: 'Shopping' },
      'OmniFocusProjectAmbiguous',
      '"Home/Shopping" (id home-shopping), "Work/Shopping" (id work-shopping); give the full path or the id',
    ],
    [{ project: 'Taxes' }, 'OmniFocusProjectClosed', '"Taxes" is completed'],
    [{ project: 'taxes' }, 'OmniFocusProjectClosed', '"Taxes" is completed'],
    [
      { project: 'Cello' },
      'OmniFocusProjectClosed',
      '"Cello" is dropped, so a task added to it would be dropped already. The OmniFocus project "Cello" is completed',
    ],
  ])('refuses %j before creating anything', (fields, error, detail) => {
    const reply = evaluate(createTask, { name: 'x', ...fields })

    expect(reply._tag).toBe(error)
    expect(reply.message).toContain(detail)
    expect(tasks).toEqual([])
  })
})

const existing = (fields: Partial<FakeTask> = {}) =>
  Object.assign(new FakeTask('Existing'), fields)

describe('updateTask', () => {
  test('leaves out what is omitted and removes what is named in clear', () => {
    const task = existing({
      note: 'keep',
      deferDate: local(2026, 10, 27, 6, 0),
      dueDate: local(2026, 10, 28, 17, 0),
      repetitionRule: new FakeRule('FREQ=DAILY', null, null, null, null),
      tags: [morning],
    })

    const reply = evaluate(updateTask, {
      id: task.id.primaryKey,
      clear: ['deferDate', 'repeat'],
    })

    expect(reply.task).toMatchObject({
      name: 'Existing',
      note: 'keep',
      deferDate: null,
      dueDate: '2026-10-28 17:00',
      tags: ['Slot/Morning'],
      repeat: null,
    })
  })

  test('refuses a field that is both given and cleared, and changes nothing', () => {
    const task = existing({ deferDate: local(2026, 10, 27, 6, 0) })

    const reply = evaluate(updateTask, {
      id: task.id.primaryKey,
      deferDate: '2026-10-30',
      clear: ['deferDate'],
    })

    expect(reply._tag).toBe('OmniFocusUpdateConflict')
    expect(task.deferDate).toEqual(local(2026, 10, 27, 6, 0))
  })

  test('replaces the tags with the given ones, in the given order', () => {
    const task = existing({ tags: [morning, slot] })

    const reply = evaluate(updateTask, {
      id: task.id.primaryKey,
      tags: ['Home', 'Slot/Morning'],
    })

    expect(reply.task.tags).toEqual(['Home', 'Slot/Morning'])
  })

  test('rebuilds a repeat from the existing rule, changing only the given fields', () => {
    const task = existing({
      repetitionRule: new FakeRule(
        'FREQ=DAILY;INTERVAL=4',
        null,
        Schedule.FromCompletion,
        Anchor.DeferDate,
        false,
      ),
    })
    ruleCalls = []

    const reply = evaluate(updateTask, {
      id: task.id.primaryKey,
      repeat: { catchUp: true },
    })

    expect(ruleCalls).toEqual([
      [
        'FREQ=DAILY;INTERVAL=4',
        null,
        Schedule.FromCompletion,
        Anchor.DeferDate,
        true,
      ],
    ])
    expect(reply.task.repeat).toEqual({
      rule: 'FREQ=DAILY;INTERVAL=4',
      schedule: 'fromCompletion',
      anchor: 'deferDate',
      catchUp: true,
    })
  })

  test('a repeat without a rule on a task that does not repeat changes nothing at all', () => {
    const task = existing()

    const reply = evaluate(updateTask, {
      id: task.id.primaryKey,
      name: 'Renamed',
      repeat: { schedule: 'regularly' },
    })

    expect(reply._tag).toBe('OmniFocusRepeatInvalid')
    expect(task.name).toBe('Existing')
  })

  test('an unknown tag changes nothing at all', () => {
    const task = existing({ tags: [morning] })

    const reply = evaluate(updateTask, {
      id: task.id.primaryKey,
      name: 'Renamed',
      tags: ['Home', 'Nope'],
    })

    expect(reply._tag).toBe('OmniFocusTagNotFound')
    expect([task.name, task.tags]).toEqual(['Existing', [morning]])
  })

  test('project moves the task to the end of that project, and clearing project moves it to the Inbox', () => {
    const task = existing()

    const moved = evaluate(updateTask, {
      id: task.id.primaryKey,
      project: 'Domestic/Housekeeping',
    })
    const back = evaluate(updateTask, {
      id: task.id.primaryKey,
      clear: ['project'],
    })

    expect(moved.task.project).toBe('Domestic/Housekeeping')
    expect(back.task.project).toBeNull()
    expect(moves).toEqual([
      [[task.id.primaryKey], 'housekeeping.ending'],
      [[task.id.primaryKey], 'inbox.ending'],
    ])
  })

  test('a task already where it should go is not moved', () => {
    const inProject = existing({ containingProject: housekeeping })
    const inInbox = existing()

    evaluate(updateTask, {
      id: inProject.id.primaryKey,
      project: 'Housekeeping',
    })
    evaluate(updateTask, { id: inInbox.id.primaryKey, clear: ['project'] })

    expect(moves).toEqual([])
  })

  test.each([[{ project: 'Garden' }], [{ clear: ['project'] as const }]])(
    "refuses to move a project's own task with %j, and changes nothing",
    (fields) => {
      const task = existing({
        containingProject: housekeeping,
        project: housekeeping,
      })

      const reply = evaluate(updateTask, {
        id: task.id.primaryKey,
        name: 'Renamed',
        ...fields,
      })

      expect(reply._tag).toBe('OmniFocusTaskIsProject')
      expect(reply.message).toContain('"Domestic/Housekeeping" itself')
      expect([task.name, moves]).toEqual(['Existing', []])
    },
  )

  test.each([
    [{ project: 'Nope' }, 'OmniFocusProjectNotFound'],
    [{ project: 'Shopping' }, 'OmniFocusProjectAmbiguous'],
    [{ project: 'Taxes' }, 'OmniFocusProjectClosed'],
    [{ project: 'Cello' }, 'OmniFocusProjectClosed'],
    [
      { project: 'Housekeeping', clear: ['project'] as const },
      'OmniFocusUpdateConflict',
    ],
  ])('%j is %s and changes nothing at all', (fields, error) => {
    const task = existing()

    const reply = evaluate(updateTask, {
      id: task.id.primaryKey,
      name: 'Renamed',
      ...fields,
    })

    expect(reply._tag).toBe(error)
    expect([task.name, moves]).toEqual(['Existing', []])
  })

  test('an unknown id is OmniFocusTaskNotFound', () => {
    expect(evaluate(updateTask, { id: 'gone', name: 'x' })._tag).toBe(
      'OmniFocusTaskNotFound',
    )
  })
})

describe('completeTasks', () => {
  const daily = (name = 'Existing') =>
    existing({
      name,
      deferDate: local(2026, 10, 27, 6, 0),
      repetitionRule: new FakeRule(
        'FREQ=DAILY',
        null,
        null,
        Anchor.DeferDate,
        null,
      ),
    })
  const complete = (...items: CompleteTasksParams['tasks']) =>
    evaluate(completeTasks, { tasks: items })

  test('completes the occurrence the caller saw and returns the next one', () => {
    const task = daily()

    const [result] = complete({
      id: task.id.primaryKey,
      deferDate: '2026-10-27 06:00',
    }).results

    expect(result.id).toBe(task.id.primaryKey)
    expect(result.completed).toMatchObject({
      status: 'Completed',
      deferDate: '2026-10-27 06:00',
    })
    expect(result.completed.id).not.toBe(task.id.primaryKey)
    expect(result.next).toMatchObject({
      id: task.id.primaryKey,
      status: 'Available',
      deferDate: '2026-10-28 06:00',
    })
  })

  test('completes every task given, and answers in the order given', () => {
    const stretch = daily('Stretch')
    const pack = existing({ name: 'Pack bag' })
    const shoes = existing({ name: 'Shoes on' })

    const reply = complete(
      { id: shoes.id.primaryKey },
      { id: stretch.id.primaryKey, deferDate: '2026-10-27 06:00' },
      { id: pack.id.primaryKey, deferDate: null },
    )

    expect(
      reply.results.map((r: { id: string; completed: { status: string } }) => [
        r.id,
        r.completed.status,
      ]),
    ).toEqual([
      [shoes.id.primaryKey, 'Completed'],
      [stretch.id.primaryKey, 'Completed'],
      [pack.id.primaryKey, 'Completed'],
    ])
    expect(stretch.deferDate).toEqual(local(2026, 10, 28, 6, 0))
  })

  test('a repeating task without a deferDate changes nothing, and the refusal gives the deferDate it is on now', () => {
    const task = daily('Stretch')

    expect(complete({ id: task.id.primaryKey })).toEqual({
      _tag: 'OmniFocusOccurrenceRequired',
      message:
        '"Stretch" repeats, so give the deferDate you saw for it: 2026-10-27 06:00 if you mean the occurrence it is on now. Nothing changed.',
    })
    expect(task.deferDate).toEqual(local(2026, 10, 27, 6, 0))
  })

  test('changes nothing once the task has moved on from the deferDate the caller saw', () => {
    const task = daily()
    complete({ id: task.id.primaryKey, deferDate: '2026-10-27 06:00' })

    const reply = complete({
      id: task.id.primaryKey,
      deferDate: '2026-10-27 06:00',
    })

    expect(reply).toEqual({
      _tag: 'OmniFocusOccurrenceMoved',
      message:
        '"Existing" is now deferred to 2026-10-28 06:00, not 2026-10-27 06:00, so the occurrence you saw was probably already completed; read the task again before completing it. Nothing changed.',
    })
    expect(task.deferDate).toEqual(local(2026, 10, 28, 6, 0))
  })

  test('one task that cannot be completed stops the whole batch, and the refusal names every such task', () => {
    const fine = existing({ name: 'Fine' })
    const moved = daily('Moved')
    const plain = existing({ name: 'Plain' })

    const reply = complete(
      { id: fine.id.primaryKey },
      { id: moved.id.primaryKey, deferDate: '2026-10-26 06:00' },
      { id: 'gone' },
      { id: plain.id.primaryKey, skip: true },
    )

    expect(reply._tag).toBe('OmniFocusOccurrenceMoved')
    expect(reply.message).toBe(
      '3 of the 4 tasks can\'t be completed, so nothing changed. OmniFocusOccurrenceMoved: "Moved" is now deferred to 2026-10-27 06:00, not 2026-10-26 06:00, so the occurrence you saw was probably already completed; read the task again before completing it. OmniFocusTaskNotFound: No OmniFocus task has the id "gone". OmniFocusNotRepeating: "Plain" does not repeat, so it has no occurrence to skip.',
    )
    expect([fine, moved, plain].map((t) => t.taskStatus)).toEqual([
      Status.Available,
      Status.Available,
      Status.Available,
    ])
    expect(moved.deferDate).toEqual(local(2026, 10, 27, 6, 0))
  })

  test('a task listed twice is refused, since a repeating one would move on twice', () => {
    const task = daily()

    const reply = complete(
      { id: task.id.primaryKey, deferDate: '2026-10-27 06:00' },
      { id: task.id.primaryKey, deferDate: '2026-10-27 06:00' },
    )

    expect(reply._tag).toBe('OmniFocusTasksOverlap')
    expect(task.deferDate).toEqual(local(2026, 10, 27, 6, 0))
  })

  test('a task listed with a group it is inside is refused, since completing it can complete the group', () => {
    const group = daily('Morning routine')
    const step = existing({ name: 'Brush teeth', parent: group })
    const nested = existing({ name: 'Floss', parent: step })

    const reply = complete(
      { id: group.id.primaryKey, deferDate: '2026-10-27 06:00' },
      { id: nested.id.primaryKey },
    )

    expect(reply).toEqual({
      _tag: 'OmniFocusTasksOverlap',
      message:
        '"Floss" is inside "Morning routine", which is also listed, and completing it can complete "Morning routine" too. Complete "Morning routine" in a separate call if it is still open after. Nothing changed.',
    })
    expect(group.deferDate).toEqual(local(2026, 10, 27, 6, 0))
  })

  test('compares a missing deferDate as null', () => {
    const task = existing()

    expect(
      complete({ id: task.id.primaryKey, deferDate: '2026-10-27 06:00' })._tag,
    ).toBe('OmniFocusOccurrenceMoved')
    expect(
      complete({ id: task.id.primaryKey, deferDate: null }).results[0].completed
        .status,
    ).toBe('Completed')
  })

  test('a task that does not repeat has no next occurrence, and completing it again changes nothing', () => {
    const task = existing()

    const first = complete({ id: task.id.primaryKey })
    const again = complete({ id: task.id.primaryKey })

    expect(first).toEqual(again)
    expect(first.results[0].next).toBeNull()
    expect(first.results[0].completed).toMatchObject({
      id: task.id.primaryKey,
      status: 'Completed',
    })
  })

  test('skip drops only this occurrence of a repeating task', () => {
    const task = daily()

    const [result] = complete({
      id: task.id.primaryKey,
      deferDate: '2026-10-27 06:00',
      skip: true,
    }).results

    expect(result.completed).toMatchObject({
      status: 'Dropped',
      deferDate: '2026-10-27 06:00',
    })
    expect(result.next).toMatchObject({
      id: task.id.primaryKey,
      deferDate: '2026-10-28 06:00',
      repeat: { rule: 'FREQ=DAILY' },
    })
  })
})

describe('createTag', () => {
  test('makes a top-level tag, or one inside a parent given by path, and answers with its full path', () => {
    expect(evaluate(createTag, { name: 'Errand run' })).toMatchObject({
      tag: { name: 'Errand run', path: 'Errand run', status: 'Active' },
      created: true,
    })
    expect(
      evaluate(createTag, { name: 'School run', parent: 'Slot' }),
    ).toMatchObject({ tag: { path: 'Slot/School run' }, created: true })
  })

  test('a tag already in that place is returned as it is, so a retry makes no second one', () => {
    const before = tags.length

    expect(evaluate(createTag, { name: 'Morning', parent: 'Slot' })).toEqual({
      tag: {
        id: 'morning',
        name: 'Morning',
        path: 'Slot/Morning',
        status: 'Active',
      },
      created: false,
    })
    expect(evaluate(createTag, { name: 'Morning' }).created).toBe(true)
    expect(tags.length).toBe(before + 1)
  })

  test('an unknown or ambiguous parent makes nothing', () => {
    const before = tags.length

    expect(evaluate(createTag, { name: 'x', parent: 'Nope' })._tag).toBe(
      'OmniFocusTagNotFound',
    )
    expect(evaluate(createTag, { name: 'x', parent: 'Evening' })._tag).toBe(
      'OmniFocusTagAmbiguous',
    )
    expect(tags.length).toBe(before)
  })
})

describe('createProject', () => {
  test('makes a project at the top level, or in a folder given by path, with a note', () => {
    expect(evaluate(createProject, { name: 'School run' })).toMatchObject({
      project: { name: 'School run', path: 'School run', status: 'Active' },
      created: true,
    })
    const reply = evaluate(createProject, {
      name: 'Groceries',
      folder: 'Home/Lists',
      note: 'weekly',
    })
    expect(reply).toMatchObject({
      project: { path: 'Home/Lists/Groceries' },
      created: true,
    })
    expect(projects.at(-1)?.note).toBe('weekly')
  })

  test('an open project already in that folder is returned as it is; a completed one does not count', () => {
    const before = projects.length

    expect(
      evaluate(createProject, { name: 'Housekeeping', folder: 'Domestic' }),
    ).toEqual({
      project: {
        id: 'housekeeping',
        name: 'Housekeeping',
        path: 'Domestic/Housekeeping',
        status: 'Active',
      },
      created: false,
    })
    expect(evaluate(createProject, { name: 'Bikes' }).created).toBe(false)
    expect(evaluate(createProject, { name: 'Taxes' }).created).toBe(true)
    expect(evaluate(createProject, { name: 'Housekeeping' }).created).toBe(true)
    expect(projects.length).toBe(before + 2)
  })

  test('an unknown or ambiguous folder makes nothing', () => {
    const before = projects.length

    expect(evaluate(createProject, { name: 'x', folder: 'Nope' })).toEqual({
      _tag: 'OmniFocusFolderNotFound',
      message:
        'No OmniFocus folder has the id, path or name "Nope". Folders are never created. Nothing changed.',
    })
    expect(evaluate(createProject, { name: 'x', folder: 'Lists' })).toEqual({
      _tag: 'OmniFocusFolderAmbiguous',
      message:
        '"Lists" could be any of "Home/Lists" (id home-lists), "Work/Lists" (id work-lists); give the full path or the id. Nothing changed.',
    })
    expect(projects.length).toBe(before)
  })
})

describe('findTasks', () => {
  const find = (args: FindTasksParams, limit = 100) =>
    evaluate(findTasks, { ...args, limit })
  const names = (reply: { tasks: ReadonlyArray<{ name: string }> }) =>
    reply.tasks.map((t) => t.name)

  test('with nothing to match, every remaining task; closed ones only with includeClosed', () => {
    existing({ name: 'Open' })
    existing({ name: 'Done', taskStatus: Status.Completed })
    existing({ name: 'Gave up', taskStatus: Status.Dropped })

    expect(find({})).toEqual({
      tasks: [expect.objectContaining({ name: 'Open' })],
      omitted: 0,
    })
    expect(names(find({ includeClosed: true }))).toEqual([
      'Open',
      'Done',
      'Gave up',
    ])
  })

  test('text matches part of the name in any case', () => {
    existing({ name: 'Take Ella out before bed' })
    existing({ name: 'Bedtime story' })
    existing({ name: 'Walk' })

    expect(names(find({ text: 'BED' }))).toEqual([
      'Take Ella out before bed',
      'Bedtime story',
    ])
  })

  test('a tag matches the tags nested under it, and a name matches every tag that has it', () => {
    existing({ name: 'Stretch', tags: [morning] })
    const evenings = tags.filter((t) => t.name === 'Evening')
    existing({ name: 'Read', tags: evenings.slice(0, 1) })
    existing({ name: 'Log off', tags: evenings.slice(1) })
    existing({ name: 'Untagged' })

    expect(names(find({ tag: 'Slot' }))).toEqual(['Stretch', 'Read'])
    expect(names(find({ tag: 'Evening' }))).toEqual(['Read', 'Log off'])
    expect(names(find({ tag: 'Slot/Evening' }))).toEqual(['Read'])
  })

  test('a project matches closed projects too, every project with that name, and combines with the rest', () => {
    const at = (id: string) =>
      projects.find((p) => p.id.primaryKey === id) ?? null
    existing({ name: 'Home list', containingProject: at('home-shopping') })
    existing({ name: 'Work list', containingProject: at('work-shopping') })
    existing({ name: 'File taxes', containingProject: at('taxes') })
    existing({
      name: 'Home tea',
      containingProject: at('home-shopping'),
      taskStatus: Status.Completed,
    })

    expect(names(find({ project: 'Shopping' }))).toEqual([
      'Home list',
      'Work list',
    ])
    expect(names(find({ project: 'Taxes' }))).toEqual(['File taxes'])
    expect(
      names(
        find({ project: 'Home/Shopping', text: 'tea', includeClosed: true }),
      ),
    ).toEqual(['Home tea'])
  })

  test('an unknown project or tag is refused rather than finding nothing', () => {
    expect(find({ project: 'Nope' })._tag).toBe('OmniFocusProjectNotFound')
    expect(find({ tag: 'Nope' })._tag).toBe('OmniFocusTagNotFound')
  })

  test('lists at most the limit and counts the rest', () => {
    for (const name of ['a', 'b', 'c']) existing({ name })

    expect(find({}, 2)).toMatchObject({
      tasks: [{ name: 'a' }, { name: 'b' }],
      omitted: 1,
    })
  })
})

describe('read scripts', () => {
  test('snapshot holds open tasks only, with the fields perspective rules look at', () => {
    existing({ tags: [morning], deferDate: local(2026, 11, 1, 6, 0) })
    existing({ taskStatus: Status.Completed })
    existing({ taskStatus: Status.Dropped })
    const parent = existing({ taskStatus: Status.Next })
    parent.children = [existing()]

    const reply = evaluate(snapshot, {})

    expect(
      reply.tasks.map(
        (t: { status: string; tagIds: unknown; leaf: boolean }) => [
          t.status,
          t.tagIds,
          t.leaf,
        ],
      ),
    ).toEqual([
      ['Available', ['morning'], true],
      ['Next', [], false],
      ['Available', [], true],
    ])
    expect(reply.tasks[0].effectiveDeferDate).toBe('2026-11-01 06:00')
    expect(reply.tags[1]).toEqual({
      id: 'morning',
      name: 'Morning',
      parentId: 'slot',
    })
  })

  test("a task's project is the full path of its containing project", () => {
    existing({
      containingProject: project(
        'garden',
        'Garden',
        folder('outside', 'Outside', folder('domestic', 'Domestic')),
      ),
    })
    existing({ containingProject: housekeeping })
    existing()

    expect(
      evaluate(snapshot, {}).tasks.map((t: { project: unknown }) => t.project),
    ).toEqual(['Domestic/Outside/Garden', 'Domestic/Housekeeping', null])
  })

  test('listTags gives each tag its full path and status', () => {
    expect(evaluate(listTags, {}).tags[1]).toEqual({
      id: 'morning',
      name: 'Morning',
      path: 'Slot/Morning',
      status: 'Active',
    })
  })

  test('listProjects gives every project its full path and status, in OmniFocus order', () => {
    projects = [
      housekeeping,
      project('taxes', 'Taxes', null, ProjectStatus.Done),
      project('bikes', 'Bikes', null, ProjectStatus.OnHold),
    ]

    expect(evaluate(listProjects, {}).projects).toEqual([
      {
        id: 'housekeeping',
        name: 'Housekeeping',
        path: 'Domestic/Housekeeping',
        status: 'Active',
      },
      { id: 'taxes', name: 'Taxes', path: 'Taxes', status: 'Done' },
      { id: 'bikes', name: 'Bikes', path: 'Bikes', status: 'OnHold' },
    ])
  })
})

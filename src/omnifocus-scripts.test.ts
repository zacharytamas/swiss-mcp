import { beforeEach, describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import {
  completeTask,
  createTask,
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
  status: object
}
const tag = (id: string, name: string, parent: FakeTag | null = null) => ({
  id: { primaryKey: id },
  name,
  parent,
  status: enumValue('Tag.Status', 'Active'),
})

const ProjectStatus = {
  Active: enumValue('Project.Status', 'Active'),
  OnHold: enumValue('Project.Status', 'OnHold'),
  Done: enumValue('Project.Status', 'Done'),
  Dropped: enumValue('Project.Status', 'Dropped'),
}

interface FakeFolder {
  name: string
  parent: FakeFolder | null
}
interface FakeProject {
  id: { primaryKey: string }
  name: string
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
  status,
  parentFolder,
  ending: `${id}.ending`,
})

let tasks: Array<FakeTask> = []
let tags: Array<FakeTag> = []
let projects: Array<FakeProject> = []
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
  containingProject: FakeProject | null = null
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
  Project: { Status: ProjectStatus },
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
  inbox: { ending: 'inbox.ending' },
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
  const domestic = { name: 'Domestic', parent: null }
  housekeeping = project('housekeeping', 'Housekeeping', domestic)
  // Two projects named Garden: the top-level one is also a full path.
  projects = [
    housekeeping,
    project('garden', 'Garden'),
    project('domestic-garden', 'Garden', domestic),
    project('home-shopping', 'Shopping', { name: 'Home', parent: null }),
    project('work-shopping', 'Shopping', { name: 'Work', parent: null }),
    project('bikes', 'Bikes', null, ProjectStatus.OnHold),
    project('taxes', 'Taxes', null, ProjectStatus.Done),
    project('cello', 'Cello', null, ProjectStatus.Dropped),
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
  ])('creates at the end of the project %s', (ref, id, path) => {
    const { task } = evaluate(createTask, { name: 'x', project: ref })

    expect(task.project).toBe(path)
    expect(tasks[0]?.position).toBe(`${id}.ending`)
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
      '"Slot/Evening", "Work/Evening"',
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
      '"Home/Shopping", "Work/Shopping"',
    ],
    [{ project: 'Taxes' }, 'OmniFocusProjectClosed', '"Taxes" is completed'],
    [{ project: 'Cello' }, 'OmniFocusProjectClosed', '"Cello" is dropped'],
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

  test('an unknown id is OmniFocusTaskNotFound', () => {
    expect(evaluate(updateTask, { id: 'gone', name: 'x' })._tag).toBe(
      'OmniFocusTaskNotFound',
    )
  })
})

describe('completeTask', () => {
  const daily = () =>
    existing({
      deferDate: local(2026, 10, 27, 6, 0),
      repetitionRule: new FakeRule(
        'FREQ=DAILY',
        null,
        null,
        Anchor.DeferDate,
        null,
      ),
    })

  test('completes the occurrence the caller saw and returns the next one', () => {
    const task = daily()

    const reply = evaluate(completeTask, {
      id: task.id.primaryKey,
      deferDate: '2026-10-27 06:00',
    })

    expect(reply.completed).toMatchObject({
      status: 'Completed',
      deferDate: '2026-10-27 06:00',
    })
    expect(reply.completed.id).not.toBe(task.id.primaryKey)
    expect(reply.next).toMatchObject({
      id: task.id.primaryKey,
      status: 'Available',
      deferDate: '2026-10-28 06:00',
    })
  })

  test('changes nothing once the task has moved on from the deferDate the caller saw', () => {
    const task = daily()
    evaluate(completeTask, {
      id: task.id.primaryKey,
      deferDate: '2026-10-27 06:00',
    })

    const reply = evaluate(completeTask, {
      id: task.id.primaryKey,
      deferDate: '2026-10-27 06:00',
    })

    expect(reply).toEqual({
      _tag: 'OmniFocusOccurrenceMoved',
      message:
        '"Existing" is now deferred to 2026-10-28 06:00, not 2026-10-27 06:00, so the occurrence you saw was probably already completed. Nothing changed; read the task again before completing it.',
    })
    expect(task.deferDate).toEqual(local(2026, 10, 28, 6, 0))
  })

  test('compares a missing deferDate as null', () => {
    const task = existing()

    expect(
      evaluate(completeTask, {
        id: task.id.primaryKey,
        deferDate: '2026-10-27 06:00',
      })._tag,
    ).toBe('OmniFocusOccurrenceMoved')
    expect(
      evaluate(completeTask, { id: task.id.primaryKey, deferDate: null })
        .completed.status,
    ).toBe('Completed')
  })

  test('a task that does not repeat has no next occurrence, and completing it again changes nothing', () => {
    const task = existing()

    const first = evaluate(completeTask, {
      id: task.id.primaryKey,
      deferDate: null,
    })
    const again = evaluate(completeTask, {
      id: task.id.primaryKey,
      deferDate: null,
    })

    expect(first).toEqual(again)
    expect(first.next).toBeNull()
    expect(first.completed).toMatchObject({
      id: task.id.primaryKey,
      status: 'Completed',
    })
  })

  test('skip drops only this occurrence of a repeating task', () => {
    const task = daily()

    const reply = evaluate(completeTask, {
      id: task.id.primaryKey,
      deferDate: '2026-10-27 06:00',
      skip: true,
    })

    expect(reply.completed).toMatchObject({
      status: 'Dropped',
      deferDate: '2026-10-27 06:00',
    })
    expect(reply.next).toMatchObject({
      id: task.id.primaryKey,
      deferDate: '2026-10-28 06:00',
      repeat: { rule: 'FREQ=DAILY' },
    })
  })

  test('skip on a task that does not repeat changes nothing', () => {
    const task = existing()

    const reply = evaluate(completeTask, {
      id: task.id.primaryKey,
      deferDate: null,
      skip: true,
    })

    expect(reply._tag).toBe('OmniFocusNotRepeating')
    expect(task.taskStatus).toBe(Status.Available)
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
      containingProject: project('garden', 'Garden', {
        name: 'Outside',
        parent: { name: 'Domestic', parent: null },
      }),
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

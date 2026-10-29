import { runInNewContext } from 'node:vm'
import { program } from './omnifocus-scripts.ts'

// A stand-in for the slice of OmniJS the scripts use, written from Omni's API reference and what was measured on
// OmniFocus 4.9.3: a completed or dropped occurrence of a repeating task is a clone, and the task itself moves on a
// day. The programs run in a fresh VM context, so anything they reference besides these globals fails.
const enumValue = (type: string, name: string) => ({
  toString: () => `[object ${type}: ${name}]`,
})
export const Status = {
  Available: enumValue('Task.Status', 'Available'),
  Next: enumValue('Task.Status', 'Next'),
  Completed: enumValue('Task.Status', 'Completed'),
  Dropped: enumValue('Task.Status', 'Dropped'),
}
export const Schedule = {
  Regularly: enumValue('Task.RepetitionScheduleType', 'Regularly'),
  FromCompletion: enumValue('Task.RepetitionScheduleType', 'FromCompletion'),
}
export const Anchor = {
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

export const ProjectStatus = {
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
export const folder = (
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
export const project = (
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

export let tasks: Array<FakeTask> = []
export let tags: Array<FakeTag> = []
export let projects: Array<FakeProject> = []
let folders: Array<FakeFolder> = []
export let moves: Array<[ReadonlyArray<string>, unknown]> = []
export let ruleCalls: Array<ReadonlyArray<unknown>> = []
let nextId = 1

export class FakeRule {
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

export const evaluate = <A>(
  script: Parameters<typeof program<A>>[0],
  args: A,
) => JSON.parse(runInNewContext(program(script, args), globals()) as string)

export const local = (
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
) => new Date(y, mo - 1, d, h, mi)

export let slot: FakeTag
export let morning: FakeTag
export let housekeeping: FakeProject
// Every test starts from this database.
export const reset = () => {
  nextId = 1
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
}

export const existing = (fields: Partial<FakeTask> = {}) =>
  Object.assign(new FakeTask('Existing'), fields)

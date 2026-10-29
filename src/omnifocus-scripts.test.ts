import { beforeEach, describe, expect, test } from 'bun:test'
import {
  Anchor,
  evaluate,
  existing,
  FakeRule,
  housekeeping,
  local,
  morning,
  moves,
  projects,
  reset,
  ruleCalls,
  Schedule,
  slot,
  Status,
  tags,
  tasks,
} from './omnifocus-fake.ts'
import type {
  CompleteTasksParams,
  FindTasksParams,
} from './omnifocus-schema.ts'
import {
  completeTasks,
  createTask,
  findTasks,
  updateTask,
} from './omnifocus-scripts.ts'

beforeEach(reset)

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
    ruleCalls.length = 0

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

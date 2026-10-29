import { beforeEach, describe, expect, test } from 'bun:test'
import {
  evaluate,
  existing,
  folder,
  housekeeping,
  local,
  morning,
  project,
  projects,
  ProjectStatus,
  reset,
  Status,
  tags,
} from './omnifocus-fake.ts'
import {
  createProject,
  createTag,
  listProjects,
  listTags,
  snapshot,
} from './omnifocus-scripts.ts'

beforeEach(reset)

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
    projects.splice(
      0,
      projects.length,
      housekeeping,
      project('taxes', 'Taxes', null, ProjectStatus.Done),
      project('bikes', 'Bikes', null, ProjectStatus.OnHold),
    )

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

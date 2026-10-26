import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import {
  matchingTasks,
  parsePerspective,
  type RuleTag,
  type RuleTask,
} from './perspectives.ts'

// Slot > Morning > Early, and Home on its own.
const TAGS: ReadonlyArray<RuleTag> = [
  { id: 'slot', parentId: null },
  { id: 'morning', parentId: 'slot' },
  { id: 'early', parentId: 'morning' },
  { id: 'home', parentId: null },
]

const task = (
  name: string,
  fields: Partial<RuleTask> = {},
): RuleTask & { readonly name: string } => ({
  name,
  status: 'Available',
  tagIds: [],
  leaf: true,
  effectiveDeferDate: null,
  ...fields,
})

const TASKS = [
  task('available untagged'),
  task('next at home', { status: 'Next', tagIds: ['home'] }),
  task('blocked in the morning', { status: 'Blocked', tagIds: ['morning'] }),
  task('due soon, early and home', {
    status: 'DueSoon',
    tagIds: ['early', 'home'],
  }),
  task('overdue group', { status: 'Overdue', leaf: false }),
  task('deferred', {
    status: 'Blocked',
    effectiveDeferDate: '2026-11-01 06:00',
  }),
  task('completed at home', { status: 'Completed', tagIds: ['home'] }),
  task('dropped', { status: 'Dropped' }),
]

// The names of TASKS the perspective shows; throws if it is unsupported.
const shown = (rules: unknown, aggregation: unknown = 'all') =>
  matchingTasks(
    Result.getOrThrow(parsePerspective(rules, aggregation)),
    TAGS,
    TASKS,
  ).map((t) => t.name)

const reason = (rules: unknown, aggregation: unknown = 'all') => {
  const parsed = parsePerspective(rules, aggregation)
  return Result.isFailure(parsed) ? parsed.failure : 'supported'
}

const available = { actionAvailability: 'available' }
const remaining = { actionAvailability: 'remaining' }
const OPEN = TASKS.filter(
  (t) => t.status !== 'Completed' && t.status !== 'Dropped',
).map((t) => t.name)

describe('actionAvailability', () => {
  test('available keeps Available, Next, DueSoon and Overdue tasks, in the order given', () => {
    expect(shown([available])).toEqual([
      'available untagged',
      'next at home',
      'due soon, early and home',
      'overdue group',
    ])
  })

  test('remaining keeps every task that is neither completed nor dropped', () => {
    expect(shown([remaining])).toEqual(OPEN)
  })
})

describe('tag rules', () => {
  test('actionHasAnyOfTags matches a task tagged with any of them', () => {
    expect(
      shown([remaining, { actionHasAnyOfTags: ['home', 'morning'] }]),
    ).toEqual([
      'next at home',
      'blocked in the morning',
      'due soon, early and home',
    ])
  })

  test('actionHasAllOfTags matches a task tagged with every one of them', () => {
    expect(
      shown([remaining, { actionHasAllOfTags: ['home', 'early'] }]),
    ).toEqual(['due soon, early and home'])
  })

  test('a tag matches tasks tagged with any tag nested under it, at any depth', () => {
    expect(shown([remaining, { actionHasAnyOfTags: ['slot'] }])).toEqual([
      'blocked in the morning',
      'due soon, early and home',
    ])
    expect(
      shown([remaining, { actionHasAllOfTags: ['slot', 'morning'] }]),
    ).toEqual(['blocked in the morning', 'due soon, early and home'])
  })

  test('a tag does not match tasks tagged only with its parent', () => {
    expect(shown([remaining, { actionHasAnyOfTags: ['early'] }])).toEqual([
      'due soon, early and home',
    ])
  })

  test('ids of deleted tags are dropped from the rule', () => {
    expect(
      shown([remaining, { actionHasAllOfTags: ['home', 'gone'] }]),
    ).toEqual(['next at home', 'due soon, early and home'])
  })

  test('a tag rule whose tags were all deleted is ignored', () => {
    expect(shown([available, { actionHasAnyOfTags: ['gone'] }])).toEqual(
      shown([available]),
    )
    expect(shown([available, { actionHasAllOfTags: [] }])).toEqual(
      shown([available]),
    )
  })
})

describe('task rules', () => {
  test('actionIsLeaf matches tasks without (true) or with (false) children', () => {
    expect(shown([available, { actionIsLeaf: false }])).toEqual([
      'overdue group',
    ])
    expect(shown([available, { actionIsLeaf: true }])).not.toContain(
      'overdue group',
    )
  })

  test('actionHasDeferDate looks at the effective defer date', () => {
    expect(shown([remaining, { actionHasDeferDate: true }])).toEqual([
      'deferred',
    ])
    expect(shown([remaining, { actionHasDeferDate: false }])).toEqual(
      OPEN.filter((name) => name !== 'deferred'),
    )
  })
})

describe('aggregation', () => {
  test('a null top-level aggregation means all', () => {
    expect(shown([available, { actionHasAnyOfTags: ['home'] }], null)).toEqual(
      shown([available, { actionHasAnyOfTags: ['home'] }], 'all'),
    )
  })

  test('a nested none excludes tasks matching any of its rules, like the !Slotted perspective', () => {
    expect(
      shown([
        remaining,
        { actionIsLeaf: true },
        {
          aggregateType: 'none',
          aggregateRules: [{ actionHasAnyOfTags: ['slot'] }],
        },
      ]),
    ).toEqual(['available untagged', 'next at home', 'deferred'])
  })

  test('a nested any matches tasks matching one of its rules', () => {
    expect(
      shown([
        available,
        {
          aggregateType: 'any',
          aggregateRules: [
            { actionHasAnyOfTags: ['home'] },
            { actionIsLeaf: false },
          ],
        },
      ]),
    ).toEqual(['next at home', 'due soon, early and home', 'overdue group'])
  })

  test('aggregates nest to any depth', () => {
    expect(
      shown([
        remaining,
        {
          aggregateType: 'any',
          aggregateRules: [
            {
              aggregateType: 'all',
              aggregateRules: [
                { actionHasAnyOfTags: ['home'] },
                { actionHasAnyOfTags: ['slot'] },
              ],
            },
            { actionHasDeferDate: true },
          ],
        },
      ]),
    ).toEqual(['due soon, early and home', 'deferred'])
  })

  test('disabled rules are ignored wherever they are', () => {
    expect(
      shown([
        available,
        { disabledRule: { actionHasAnyOfTags: ['home'] } },
        {
          aggregateType: 'all',
          aggregateRules: [{ disabledRule: { actionIsLeaf: false } }],
        },
      ]),
    ).toEqual(shown([available]))
  })

  test('a disabled rule may hold a rule that is not supported', () => {
    expect(
      shown([remaining, { disabledRule: { actionAvailability: 'completed' } }]),
    ).toEqual(OPEN)
  })

  test('an empty all matches every task', () => {
    expect(
      shown([remaining, { aggregateType: 'all', aggregateRules: [] }]),
    ).toEqual(OPEN)
  })

  test('an empty none matches no task', () => {
    expect(
      shown([
        remaining,
        {
          aggregateType: 'none',
          aggregateRules: [{ actionHasAnyOfTags: ['gone'] }],
        },
      ]),
    ).toEqual([])
  })

  test('an empty any matches every task (assumed; not measured on OmniFocus)', () => {
    expect(
      shown([
        remaining,
        {
          aggregateType: 'any',
          aggregateRules: [{ disabledRule: { actionIsLeaf: true } }],
        },
      ]),
    ).toEqual(OPEN)
  })

  test('a top-level any of availability rules only is supported', () => {
    expect(shown([available, remaining], 'any')).toEqual(OPEN)
  })
})

describe('unsupported perspectives', () => {
  test.each([
    [
      'the availability completed (the Completed perspective)',
      [{ actionAvailability: 'completed' }],
      'all',
      'rule actionAvailability: "completed" is not supported',
    ],
    [
      'an unknown rule',
      [available, { actionDateField: 'due', actionDateIsToday: true }],
      'all',
      'rule actionDateField is not supported',
    ],
    [
      'an unknown rule nested in an aggregate',
      [
        available,
        { aggregateType: 'any', aggregateRules: [{ actionHasProject: ['p'] }] },
      ],
      'all',
      'rule actionHasProject is not supported',
    ],
    [
      'a known rule with an extra key',
      [{ actionAvailability: 'available', actionIsLeaf: true }],
      'all',
      'rule actionAvailability: "available" is not supported',
    ],
    [
      'a known rule with a value of the wrong type',
      [available, { actionIsLeaf: 'yes' }],
      'all',
      'rule actionIsLeaf: "yes" is not supported',
    ],
    [
      'a rule that is not an object',
      [available, 'available'],
      'all',
      'rule "available" is not supported',
    ],
    [
      'an unknown top-level aggregation',
      [available],
      'some',
      'top-level aggregation "some" is not supported',
    ],
    [
      'rules that are not a list',
      { available },
      'all',
      'its rules are not a list',
    ],
  ])('%s', (_, rules, aggregation, expected) => {
    expect(reason(rules, aggregation)).toBe(expected)
  })

  const noAvailability =
    'no enabled availability rule limits it to remaining actions, so OmniFocus would also show completed or dropped ones'

  test.each([
    [
      'only a disabled availability rule (the Changed perspective)',
      [{ disabledRule: remaining }],
      null,
    ],
    ['no rules at all', [], 'all'],
    ['only tag rules', [{ actionHasAnyOfTags: ['home'] }], 'all'],
    ['a top-level none', [available], 'none'],
    [
      'a top-level any that mixes in another rule',
      [available, { actionIsLeaf: true }],
      'any',
    ],
    [
      'availability only inside a nested any with another rule',
      [
        {
          aggregateType: 'any',
          aggregateRules: [available, { actionHasDeferDate: true }],
        },
      ],
      'all',
    ],
  ])('%s needs completed or dropped tasks', (_, rules, aggregation) => {
    expect(reason(rules, aggregation)).toBe(noAvailability)
  })

  test('availability inside a nested all is enough', () => {
    expect(
      reason([
        { actionHasAnyOfTags: ['home'] },
        { aggregateType: 'all', aggregateRules: [available] },
      ]),
    ).toBe('supported')
  })
})

import { Result, Schema } from 'effect'
import {
  RawRule,
  RawRules,
  TopLevelAggregation,
} from './perspectives-schema.ts'

type Aggregation = 'all' | 'any' | 'none'

type Rule =
  | {
      readonly _tag: 'Availability'
      readonly availability: 'available' | 'remaining'
    }
  | { readonly _tag: 'HasAnyOfTags'; readonly tagIds: ReadonlyArray<string> }
  | { readonly _tag: 'HasAllOfTags'; readonly tagIds: ReadonlyArray<string> }
  | { readonly _tag: 'IsLeaf'; readonly leaf: boolean }
  | { readonly _tag: 'HasDeferDate'; readonly hasDeferDate: boolean }
  | {
      readonly _tag: 'Aggregate'
      readonly aggregation: Aggregation
      readonly rules: ReadonlyArray<Rule>
    }

// What the rules look at. `status` is OmniFocus's taskStatus name.
export interface RuleTask {
  readonly status: string
  readonly tagIds: ReadonlyArray<string>
  readonly leaf: boolean
  readonly effectiveDeferDate: string | null
}

export interface RuleTag {
  readonly id: string
  readonly parentId: string | null
}

const decodeRule = Schema.decodeUnknownResult(RawRule, {
  onExcessProperty: 'error',
})
const ruleKeys = new Set([
  'actionAvailability',
  'actionHasAnyOfTags',
  'actionHasAllOfTags',
  'actionIsLeaf',
  'actionHasDeferDate',
  'aggregateType',
  'aggregateRules',
  'disabledRule',
])

const unsupported = (raw: unknown): string => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `rule ${JSON.stringify(raw)} is not supported`
  }
  const entries = Object.entries(raw)
  const [key, value] = entries.find(([k]) => !ruleKeys.has(k)) ??
    entries[0] ?? ['(empty)', undefined]
  const shown = JSON.stringify(value) ?? ''
  return ruleKeys.has(key)
    ? `rule ${key}: ${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown} is not supported`
    : `rule ${key} is not supported`
}

// A disabled rule is undefined: OmniFocus ignores it, whatever it holds.
const parseRule = (raw: unknown): Result.Result<Rule | undefined, string> => {
  const decoded = decodeRule(raw)
  if (Result.isFailure(decoded)) return Result.fail(unsupported(raw))
  const r = decoded.success
  if ('actionAvailability' in r) {
    return Result.succeed({
      _tag: 'Availability',
      availability: r.actionAvailability,
    })
  }
  if ('actionHasAnyOfTags' in r) {
    return Result.succeed({
      _tag: 'HasAnyOfTags',
      tagIds: r.actionHasAnyOfTags,
    })
  }
  if ('actionHasAllOfTags' in r) {
    return Result.succeed({
      _tag: 'HasAllOfTags',
      tagIds: r.actionHasAllOfTags,
    })
  }
  if ('actionIsLeaf' in r) {
    return Result.succeed({ _tag: 'IsLeaf', leaf: r.actionIsLeaf })
  }
  if ('actionHasDeferDate' in r) {
    return Result.succeed({
      _tag: 'HasDeferDate',
      hasDeferDate: r.actionHasDeferDate,
    })
  }
  if ('aggregateType' in r) {
    return Result.map(parseRules(r.aggregateRules), (rules) => ({
      _tag: 'Aggregate' as const,
      aggregation: r.aggregateType,
      rules,
    }))
  }
  return Result.succeed(undefined)
}

const parseRules = (
  raws: ReadonlyArray<unknown>,
): Result.Result<ReadonlyArray<Rule>, string> => {
  const rules: Array<Rule> = []
  for (const raw of raws) {
    const rule = parseRule(raw)
    if (Result.isFailure(rule)) return Result.fail(rule.failure)
    if (rule.success !== undefined) rules.push(rule.success)
  }
  return Result.succeed(rules)
}

const available = new Set(['Available', 'Next', 'DueSoon', 'Overdue'])

type Test = (task: RuleTask, tagged: ReadonlySet<string>) => boolean
interface Compiled {
  readonly test: Test
  // Every task the rule matches is remaining (neither completed nor dropped), so a snapshot of open tasks is enough.
  readonly remaining: boolean
}

// A tag rule matches a task tagged with that tag or any tag nested under it. Tag ids that no longer exist are dropped,
// and a tag rule left with none is ignored (undefined), as OmniFocus does.
const compiler = (tags: ReadonlyArray<RuleTag>) => {
  const exists = new Set(tags.map((t) => t.id))

  const aggregate = (
    aggregation: Aggregation,
    parts: ReadonlyArray<Compiled>,
  ): Result.Result<Compiled, string> => {
    switch (aggregation) {
      // Measured: an all with no rules left matches every task.
      case 'all':
        return Result.succeed({
          test: (task, tagged) => parts.every((p) => p.test(task, tagged)),
          remaining: parts.some((p) => p.remaining),
        })
      case 'any':
        return parts.length === 0
          ? Result.fail(
              'it has an any group with no rules left to apply, and what OmniFocus shows for that has not been measured',
            )
          : Result.succeed({
              test: (task, tagged) => parts.some((p) => p.test(task, tagged)),
              remaining: parts.every((p) => p.remaining),
            })
      case 'none': {
        // Measured: a none with no rules left matches no task.
        const test: Test =
          parts.length === 0
            ? () => false
            : (task, tagged) => !parts.some((p) => p.test(task, tagged))
        return Result.succeed({ test, remaining: false })
      }
    }
  }

  const compile = (rule: Rule): Result.Result<Compiled | undefined, string> => {
    switch (rule._tag) {
      case 'Availability':
        return Result.succeed({
          test:
            rule.availability === 'available'
              ? (task) => available.has(task.status)
              : (task) =>
                  task.status !== 'Completed' && task.status !== 'Dropped',
          remaining: true,
        })
      case 'HasAnyOfTags':
      case 'HasAllOfTags': {
        const ids = rule.tagIds.filter((id) => exists.has(id))
        if (ids.length === 0) return Result.succeed(undefined)
        return Result.succeed({
          test:
            rule._tag === 'HasAnyOfTags'
              ? (_, tagged) => ids.some((id) => tagged.has(id))
              : (_, tagged) => ids.every((id) => tagged.has(id)),
          remaining: false,
        })
      }
      case 'IsLeaf':
        return Result.succeed({
          test: (task) => task.leaf === rule.leaf,
          remaining: false,
        })
      case 'HasDeferDate':
        return Result.succeed({
          test: (task) =>
            (task.effectiveDeferDate !== null) === rule.hasDeferDate,
          remaining: false,
        })
      case 'Aggregate': {
        const parts: Array<Compiled> = []
        for (const r of rule.rules) {
          const part = compile(r)
          if (Result.isFailure(part)) return Result.fail(part.failure)
          if (part.success !== undefined) parts.push(part.success)
        }
        return aggregate(rule.aggregation, parts)
      }
    }
  }

  return compile
}

// Which open tasks a perspective shows, from its archivedFilterRules and archivedTopLevelFilterAggregation as
// OmniFocus reports them, or why that can't be worked out from open tasks.
export const perspectiveFilter = (
  rules: unknown,
  aggregation: unknown,
  tags: ReadonlyArray<RuleTag>,
): Result.Result<(task: RuleTask) => boolean, string> => {
  const top = Schema.decodeUnknownResult(TopLevelAggregation)(aggregation)
  if (Result.isFailure(top)) {
    return Result.fail(
      `top-level aggregation ${JSON.stringify(aggregation)} is not supported`,
    )
  }
  const raws = Schema.decodeUnknownResult(RawRules)(rules)
  if (Result.isFailure(raws)) {
    return Result.fail('its rules are not a list')
  }
  const compiled = Result.flatMap(parseRules(raws.success), (parsed) =>
    compiler(tags)({
      _tag: 'Aggregate',
      aggregation: top.success ?? 'all',
      rules: parsed,
    }),
  )
  if (Result.isFailure(compiled)) return Result.fail(compiled.failure)
  const filter = compiled.success
  if (filter === undefined || !filter.remaining) {
    return Result.fail(
      'no enabled availability rule limits it to remaining actions, so OmniFocus would also show completed or dropped ones',
    )
  }

  const parents = new Map(tags.map((t) => [t.id, t.parentId]))
  const lineages = new Map<string, ReadonlyArray<string>>()
  const lineage = (id: string) => {
    const known = lineages.get(id)
    if (known) return known
    const ids: Array<string> = []
    for (let at: string | null | undefined = id; at; at = parents.get(at)) {
      if (ids.includes(at)) break
      ids.push(at)
    }
    lineages.set(id, ids)
    return ids
  }
  return Result.succeed((task) =>
    filter.test(task, new Set(task.tagIds.flatMap(lineage))),
  )
}

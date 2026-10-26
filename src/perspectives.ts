import { Result, Schema } from 'effect'
import {
  RawRule,
  RawRules,
  TopLevelAggregation,
} from './perspectives-schema.ts'

export type Aggregation = 'all' | 'any' | 'none'

export type Rule =
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
  | { readonly _tag: 'Disabled' }

export type Filter = Extract<Rule, { readonly _tag: 'Aggregate' }>

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

const parseRule = (raw: unknown): Result.Result<Rule, string> => {
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
  return Result.succeed({ _tag: 'Disabled' })
}

const parseRules = (
  raws: ReadonlyArray<unknown>,
): Result.Result<ReadonlyArray<Rule>, string> => {
  const rules: Array<Rule> = []
  for (const raw of raws) {
    const rule = parseRule(raw)
    if (Result.isFailure(rule)) return Result.fail(rule.failure)
    rules.push(rule.success)
  }
  return Result.succeed(rules)
}

// Whether every task the rule matches is remaining (neither completed nor dropped). Only then can it be evaluated
// over a snapshot of open tasks: otherwise OmniFocus would also show completed or dropped ones.
const onlyRemaining = (rule: Rule): boolean => {
  switch (rule._tag) {
    case 'Availability':
      return true
    case 'Aggregate': {
      const enabled = rule.rules.filter((r) => r._tag !== 'Disabled')
      if (rule.aggregation === 'all') return enabled.some(onlyRemaining)
      if (rule.aggregation === 'any') {
        return enabled.length > 0 && enabled.every(onlyRemaining)
      }
      return false
    }
    default:
      return false
  }
}

// A perspective's archivedFilterRules and archivedTopLevelFilterAggregation as OmniFocus reports them, or why its
// tasks can't be computed from open tasks.
export const parsePerspective = (
  rules: unknown,
  aggregation: unknown,
): Result.Result<Filter, string> => {
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
  return Result.flatMap(
    parseRules(raws.success),
    (parsed): Result.Result<Filter, string> => {
      const filter = {
        _tag: 'Aggregate' as const,
        aggregation: top.success ?? 'all',
        rules: parsed,
      }
      return onlyRemaining(filter)
        ? Result.succeed(filter)
        : Result.fail(
            'no enabled availability rule limits it to remaining actions, so OmniFocus would also show completed or dropped ones',
          )
    },
  )
}

const available = new Set(['Available', 'Next', 'DueSoon', 'Overdue'])

// The tasks the filter matches, in the order given. A tag rule matches a task tagged with that tag or any tag nested
// under it. Tag ids that no longer exist are dropped, and a rule left with none is ignored, as OmniFocus does.
export const matchingTasks = <T extends RuleTask>(
  filter: Filter,
  tags: ReadonlyArray<RuleTag>,
  tasks: ReadonlyArray<T>,
): ReadonlyArray<T> => {
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

  type Test = (task: T, tagged: ReadonlySet<string>) => boolean | null
  const compile = (rule: Rule): Test => {
    switch (rule._tag) {
      case 'Availability':
        return rule.availability === 'available'
          ? (task) => available.has(task.status)
          : (task) => task.status !== 'Completed' && task.status !== 'Dropped'
      case 'HasAnyOfTags':
      case 'HasAllOfTags': {
        const ids = rule.tagIds.filter((id) => parents.has(id))
        if (ids.length === 0) return () => null
        return rule._tag === 'HasAnyOfTags'
          ? (_, tagged) => ids.some((id) => tagged.has(id))
          : (_, tagged) => ids.every((id) => tagged.has(id))
      }
      case 'IsLeaf':
        return (task) => task.leaf === rule.leaf
      case 'HasDeferDate':
        return (task) =>
          (task.effectiveDeferDate !== null) === rule.hasDeferDate
      case 'Aggregate': {
        const tests = rule.rules.map(compile)
        return (task, tagged) => {
          const results = tests
            .map((test) => test(task, tagged))
            .filter((r) => r !== null)
          // Measured: once ignored rules are left out, an empty all matches every task and an empty none matches
          // none. An empty any is assumed to match every task.
          if (results.length === 0) return rule.aggregation !== 'none'
          if (rule.aggregation === 'all') return results.every(Boolean)
          if (rule.aggregation === 'any') return results.some(Boolean)
          return !results.some(Boolean)
        }
      }
      case 'Disabled':
        return () => null
    }
  }

  const test = compile(filter)
  return tasks.filter(
    (task) => test(task, new Set(task.tagIds.flatMap(lineage))) === true,
  )
}

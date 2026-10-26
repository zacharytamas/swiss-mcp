import { Schema } from 'effect'

const Aggregation = Schema.Literals(['all', 'any', 'none'])
const TagIds = Schema.Array(Schema.String)

// The archivedFilterRules entries that can be evaluated from a snapshot of open tasks, in the shapes OmniFocus 4.9.3
// stores them. An aggregate's own rules are decoded one at a time so that an unsupported one can be named.
export const RawRule = Schema.Union([
  Schema.Struct({
    actionAvailability: Schema.Literals(['available', 'remaining']),
  }),
  Schema.Struct({ actionHasAnyOfTags: TagIds }),
  Schema.Struct({ actionHasAllOfTags: TagIds }),
  Schema.Struct({ actionIsLeaf: Schema.Boolean }),
  Schema.Struct({ actionHasDeferDate: Schema.Boolean }),
  Schema.Struct({
    aggregateType: Aggregation,
    aggregateRules: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({ disabledRule: Schema.Unknown }),
])

export const RawRules = Schema.Array(Schema.Unknown)

// OmniFocus reports null for some perspectives (Completed and Changed on OmniFocus 4.9.3); it is read as all.
export const TopLevelAggregation = Schema.NullOr(Aggregation)

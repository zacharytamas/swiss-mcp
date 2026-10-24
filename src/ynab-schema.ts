import { Schema } from 'effect'

export const ToolFailure = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
})

export const DailyPace = Schema.Struct({
  dailyPace: Schema.Number,
  days: Schema.Int,
  targetDate: Schema.String,
  readyToAssign: Schema.Number,
  budgetId: Schema.String,
})

// YNAB answers a failed request with this body; the client throws it as is.
export const ApiErrorBody = Schema.Struct({
  error: Schema.Struct({ name: Schema.String, detail: Schema.String }),
})

import { Config, Effect, Option, Redacted, Schema } from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import * as ynab from 'ynab'
import {
  YnabApiError,
  type YnabError,
  YnabNotConfigured,
  YnabRequestFailed,
} from './ynab-errors.ts'
import { ApiErrorBody, DailyPace, ToolFailure } from './ynab-schema.ts'

// The next given day of the month strictly after `today`. A day past the month's end means its last day.
export const paceTarget = (today: Temporal.PlainDate, day: number) => {
  const thisMonth = today.with({ day })
  return Temporal.PlainDate.compare(thisMonth, today) > 0
    ? thisMonth
    : today.add({ months: 1 }).with({ day })
}

export const YnabToolkit = Toolkit.make(
  Tool.make('ynab_daily_pace', {
    description:
      "Daily spending pace: YNAB's Ready to Assign divided by the days until the next pacing date. Amounts are in the budget's currency, such as dollars, not YNAB milliunits. It is a guide, not a spending target. A negative pace means more money is assigned than is available.",
    parameters: Tool.EmptyParams,
    success: DailyPace,
    failure: ToolFailure,
    failureMode: 'return',
  })
    .annotate(Tool.Strict, true)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, true),
)

const notConfigured = (message: string) => new YnabNotConfigured({ message })

export const YnabToolkitLive = YnabToolkit.toLayer(
  Effect.gen(function* () {
    const token = yield* Config.option(Config.Redacted('YNAB_ACCESS_TOKEN'))
    const budgetId = yield* Config.option(Config.String('YNAB_BUDGET_ID'))
    const paceDay = yield* Config.String('YNAB_PACE_DAY').pipe(
      Config.withDefault('15'),
    )
    // Overridable so the whole server can be exercised against a fake YNAB.
    const base = yield* Config.String('SWISS_YNAB_API_URL').pipe(
      Config.withDefault(ynab.BASE_PATH),
    )

    const dailyPace = Effect.gen(function* () {
      if (Option.isNone(token)) {
        return yield* notConfigured(
          'Set YNAB_ACCESS_TOKEN to a YNAB personal access token in the MCP server environment.',
        )
      }
      if (Option.isNone(budgetId)) {
        return yield* notConfigured(
          'Set YNAB_BUDGET_ID to the budget ID (the UUID in the YNAB web app URL) in the MCP server environment.',
        )
      }
      const day = Number(paceDay)
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        return yield* notConfigured(
          `YNAB_PACE_DAY must be a day of the month from 1 to 31, got "${paceDay}".`,
        )
      }
      const api = new ynab.API(token.value.pipe(Redacted.value), base)
      const { data } = yield* Effect.tryPromise({
        try: () => api.months.getPlanMonth(budgetId.value, 'current'),
        catch: (cause) =>
          Schema.decodeUnknownOption(ApiErrorBody)(cause).pipe(
            Option.match({
              onNone: (): YnabError =>
                new YnabRequestFailed({ message: String(cause) }),
              onSome: ({ error }) =>
                new YnabApiError({ code: error.name, message: error.detail }),
            }),
          ),
      })
      const today = Temporal.Now.plainDateISO()
      const target = paceTarget(today, day)
      const days = today.until(target).days
      const milliunits = data.month.to_be_budgeted
      return {
        // Floored in integer milliunits: floor(units * 100) in floating point loses a cent, e.g. 0.29 * 100.
        dailyPace: Math.floor(milliunits / (days * 10)) / 100,
        days,
        targetDate: target.toString(),
        readyToAssign: milliunits / 1000,
        budgetId: budgetId.value,
      }
    })

    return {
      ynab_daily_pace: () =>
        dailyPace.pipe(
          Effect.mapError((e) => ({
            error:
              e._tag === 'YnabApiError' ? `YnabApiError:${e.code}` : e._tag,
            message: e.message,
          })),
        ),
    }
  }),
)

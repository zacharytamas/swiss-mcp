import { Schema } from 'effect'

export const Reminder = Schema.Struct({
  title: Schema.String,
  dueDate: Schema.String,
})
export const Titled = Schema.Struct({ title: Schema.String })
export const Timer = Schema.Struct({ name: Schema.String })
const Name = Schema.String.check(Schema.isNonEmpty())
// Due stores a reminder's time as local wall-clock time to the minute, in this Mac's time zone (measured on Due
// 26.4.4), so tools take exactly that and pass it through. The only check needed is that the date exists: JS Date
// would roll "2026-02-30" forward to March 2, so the written fields must read back unchanged.
// This Effect version publishes neither `pattern` nor checks after a custom filter in the tool's JSON Schema, so
// the description is what tells an MCP client the format; it is attached before the date-exists filter.
const LocalDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, {
    message: 'must be YYYY-MM-DD HH:mm in local time',
  }),
)
  .annotate({
    description:
      'Local date and time on this Mac, to the minute, as YYYY-MM-DD HH:mm (e.g. 2026-10-17 09:30). Due resolves the hour that repeats when clocks fall back the same way its own app does.',
  })
  .check(
    Schema.makeFilter<string>((s) => {
      const [y, mo, d, h, mi] = s.split(/[- :]/).map(Number)
      const back = new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d, h, mi))
      return back.getUTCFullYear() === y &&
        back.getUTCMonth() + 1 === mo &&
        back.getUTCDate() === d &&
        back.getUTCHours() === h &&
        back.getUTCMinutes() === mi
        ? undefined
        : `${s} does not exist`
    }),
  )

export const ByTitle = { title: Name }
export const ByTitleAt = { title: Name, dueDate: LocalDateTime }
export const ByName = { name: Name }

export const ToolFailure = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
})

export const reminders = <S extends Schema.Top>(items: S) =>
  Schema.Struct({ reminders: items })
export const timers = <S extends Schema.Top>(items: S) =>
  Schema.Struct({ timers: items })

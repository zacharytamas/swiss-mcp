import { Schema } from 'effect'

export const ShortcutId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ShortcutId'),
)
export type ShortcutId = typeof ShortcutId.Type

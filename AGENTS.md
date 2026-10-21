# Agent conventions

## Named Schemas live in `*-schema.ts`

A named Schema goes in a sibling file named after the module that primarily uses it. A named Schema is a variable or function whose value is a `Schema.*` expression, or a factory that returns one. For example, `src/due.ts` imports its Schemas from `src/due-schema.ts`.

- Export what the module needs. Keep helpers that only build those Schemas (e.g. `Name`, `LocalDateTime` in `due-schema.ts`) unexported.
- Inline, unnamed Schemas at a call site (e.g. `contract(Schema.Struct({ op: ... }), ...)`) stay where they are.
- Values produced from a Schema (`Schema.decodeUnknownSync(Reminder)(payload)`, `Schema.is(Reminder)`, `Schema.isNonEmpty()`) are not Schemas and may live anywhere.
- Tests (`*.test.ts`) may define throwaway Schemas inline.

`lint/schema-location.grit` enforces this as a Biome plugin, so `bun run check` fails on a named Schema anywhere else.

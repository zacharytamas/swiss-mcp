# Agent conventions

## Named Schemas live in `*-schema.ts`

A named Schema goes in a sibling file named after the module that primarily uses it. A named Schema is a variable or function whose value is a `Schema.*` expression, or a factory that returns one. For example, `src/due.ts` imports its Schemas from `src/due-schema.ts`.

- Export what the module needs. Keep helpers that only build those Schemas (e.g. `Name`, `LocalDateTime` in `due-schema.ts`) unexported.
- Inline, unnamed Schemas at a call site (e.g. `contract(Schema.Struct({ op: ... }), ...)`) stay where they are.
- Values produced from a Schema (`Schema.decodeUnknownSync(Reminder)(payload)`, `Schema.is(Reminder)`, `Schema.isNonEmpty()`) are not Schemas and may live anywhere. Combinators that return a Schema (`Schema.decodeTo`, `Schema.encodeTo`, `Schema.decode`, `Schema.make`, `Schema.toCodecJson`) are Schemas.
- Tests (`*.test.ts`) may define throwaway Schemas inline.

`lint/schema-location.grit` enforces this as a Biome plugin, so `bun run check` fails on a named Schema anywhere else.

## Error classes live in `*-errors.ts`

A class that extends `Schema.TaggedError`, `Schema.Error`, `Data.TaggedError`, `Data.Error` or `Error` goes in a sibling `*-errors.ts` file, along with the union type of those errors. For example, `src/shortcuts.ts` imports its errors from `src/shortcuts-errors.ts`. Field records shared only by the errors (e.g. `fields`) stay unexported there. Tests may define error classes inline.

`lint/error-location.grit` enforces this. `lint/location.test.ts` covers both rules, so add a case there when you change either one.

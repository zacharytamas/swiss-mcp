import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = `import { Data, Schema } from 'effect'
export const A = Schema.Struct({ a: Schema.String })
export const list = <S extends Schema.Top>(items: S) => Schema.Array(items)
export function literal(x: string) { return Schema.Literal(x) }
export class Failed extends Schema.TaggedError<Failed>()('Failed', {}) {}
export class Missing extends Data.TaggedError('Missing')<{}> {}
export class Plain extends Error {}
export const value = Schema.decodeUnknownSync(A)({ a: 'x' })
export const encode = Schema.encodeSync(A)
export const isA = Schema.is(A)
export const decode = (u: unknown) => Schema.decodeUnknownExit(A)(u)
export const nonEmpty = Schema.isNonEmpty()
export const inline = [Schema.String]
export class Person extends Schema.Class<Person>('Person')({}) {}
`

const flagged = (file: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'location-'))
  writeFileSync(
    join(dir, 'biome.json'),
    JSON.stringify({
      plugins: ['schema-location.grit', 'error-location.grit'].map((rule) =>
        join(import.meta.dir, rule),
      ),
      linter: { rules: { recommended: false } },
    }),
  )
  writeFileSync(join(dir, file), source)
  const { stdout } = Bun.spawnSync(
    ['bunx', 'biome', 'lint', '--reporter=json', file],
    { cwd: dir },
  )
  const report = JSON.parse(stdout.toString()) as {
    diagnostics: Array<{
      message: string
      location: { start: { line: number } }
    }>
  }
  return report.diagnostics
    .map(
      (d) =>
        `${d.location.start.line} ${d.message.includes('*-schema.ts') ? 'schema' : 'error'}`,
    )
    .sort()
}

test('flags named Schemas and error classes, not values derived from Schemas', () => {
  expect(flagged('module.ts')).toEqual([
    '2 schema',
    '3 schema',
    '4 schema',
    '5 error',
    '6 error',
    '7 error',
  ])
})

test('allows named Schemas only in *-schema.ts', () => {
  expect(flagged('module-schema.ts')).toEqual(['5 error', '6 error', '7 error'])
})

test('allows error classes only in *-errors.ts', () => {
  expect(flagged('module-errors.ts')).toEqual([
    '2 schema',
    '3 schema',
    '4 schema',
  ])
})

test('lets tests define both', () => {
  expect(flagged('module.test.ts')).toEqual([])
})

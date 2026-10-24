import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
export const NumberFromString = Schema.decodeTo(Schema.Number)(Schema.String)
export const StringToNumber = Schema.encodeTo(Schema.String)(Schema.Number)
export const Rebuilt = Schema.make<typeof A>(A.ast)
export const Trimmed = Schema.decode({ decode: (s) => s, encode: (s) => s })
export const Json = Schema.toCodecJson(A)
export const literal2 = ((s: string) => Schema.Literal(s)) satisfies Function
export const Expr = class Expr extends Data.TaggedError('Expr')<{}> {}
export default class extends Error {}
`

const flagged = (file: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'location-'))
  try {
    writeFileSync(join(dir, file), source)
    const { stdout, exitCode } = Bun.spawnSync(
      [
        join(import.meta.dir, '../node_modules/.bin/oxlint'),
        `--config=${join(import.meta.dir, '../.oxlintrc.json')}`,
        '--format=json',
        file,
      ],
      { cwd: dir },
    )
    const report = JSON.parse(stdout.toString()) as {
      diagnostics: Array<{
        code: string
        labels: Array<{ span: { line: number } }>
      }>
    }
    expect(exitCode).toBe(report.diagnostics.length > 0 ? 1 : 0)
    return report.diagnostics
      .filter((d) => d.code.startsWith('location('))
      .map(
        (d) =>
          `${d.labels[0]?.span.line} ${d.code === 'location(schema-location)' ? 'schema' : 'error'}`,
      )
      .sort()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('flags named Schemas and error classes, not values derived from Schemas', () => {
  expect(flagged('module.ts')).toEqual([
    '15 schema',
    '16 schema',
    '17 schema',
    '18 schema',
    '19 schema',
    '2 schema',
    '20 schema',
    '21 error',
    '22 error',
    '3 schema',
    '4 schema',
    '5 error',
    '6 error',
    '7 error',
  ])
})

test('allows named Schemas only in *-schema.ts', () => {
  expect(flagged('module-schema.ts')).toEqual([
    '21 error',
    '22 error',
    '5 error',
    '6 error',
    '7 error',
  ])
})

test('allows error classes only in *-errors.ts', () => {
  expect(flagged('module-errors.ts')).toEqual([
    '15 schema',
    '16 schema',
    '17 schema',
    '18 schema',
    '19 schema',
    '2 schema',
    '20 schema',
    '3 schema',
    '4 schema',
  ])
})

test('lets tests define both', () => {
  expect(flagged('module.test.ts')).toEqual([])
})

test('flags both in bare schema.ts and errors.ts, which name no module', () => {
  expect(flagged('schema.ts')).toEqual(flagged('module.ts'))
  expect(flagged('errors.ts')).toEqual(flagged('module.ts'))
})

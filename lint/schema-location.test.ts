import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = `import { Schema } from 'effect'
export const A = Schema.Struct({ a: Schema.String })
export const list = <S extends Schema.Top>(items: S) => Schema.Array(items)
export function literal(x: string) { return Schema.Literal(x) }
export const value = Schema.decodeUnknownSync(A)({ a: 'x' })
export const encode = Schema.encodeSync(A)
export const isA = Schema.is(A)
export const decode = (u: unknown) => Schema.decodeUnknownExit(A)(u)
export const nonEmpty = Schema.isNonEmpty()
export const inline = [Schema.String]
`

const flaggedLines = (file: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'schema-location-'))
  writeFileSync(
    join(dir, 'biome.json'),
    JSON.stringify({
      plugins: [join(import.meta.dir, 'schema-location.grit')],
      linter: { rules: { recommended: false } },
    }),
  )
  writeFileSync(join(dir, file), source)
  const { stdout } = Bun.spawnSync(
    ['bunx', 'biome', 'lint', '--reporter=json', file],
    { cwd: dir },
  )
  const report = JSON.parse(stdout.toString()) as {
    diagnostics: Array<{ location: { start: { line: number } } }>
  }
  return report.diagnostics.map((d) => d.location.start.line).sort()
}

test('flags Schemas and Schema factories but not decoded values or checks', () => {
  expect(flaggedLines('module.ts')).toEqual([2, 3, 4])
})

test('allows named Schemas in *-schema.ts files', () => {
  expect(flaggedLines('module-schema.ts')).toEqual([])
})

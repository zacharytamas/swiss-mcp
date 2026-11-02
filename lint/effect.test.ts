import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = `import { Effect } from 'effect'
export const plain = (n: number) => Effect.gen(function* () { return n })
export const scoped = (n: number) => Effect.scoped(Effect.gen(function* () { return n }))
export const piped = (n: number) => Effect.gen(function* () { return n }).pipe(Effect.orDie)
export const typed = (n: number): Effect.Effect<number> => Effect.gen(function* () { return n })
export const cast = ((n: number) => Effect.gen(function* () { return n })) satisfies Function
export const named = Effect.fn('named')(function* (n: number) { return n })
export const value = Effect.gen(function* () { return 1 })
export const callback = Effect.forEach([1], (n) => Effect.gen(function* () { return n }))
export const other = (n: number) => Effect.succeed(n)
export const block = (n: number) => { return Effect.gen(function* () { return n }) }
`

const flagged = () => {
  const dir = mkdtempSync(join(tmpdir(), 'effect-'))
  try {
    writeFileSync(join(dir, 'module.ts'), source)
    const { stdout } = Bun.spawnSync(
      [
        join(import.meta.dir, '../node_modules/.bin/oxlint'),
        '--format=json',
        join(dir, 'module.ts'),
      ],
      // From the repo root, as bun run check runs it, so oxlint finds .oxlintrc.json and oxlint-tsgolint.
      { cwd: join(import.meta.dir, '..') },
    )
    const report = JSON.parse(stdout.toString()) as {
      diagnostics: Array<{
        code: string
        labels: Array<{ span: { line: number } }>
      }>
    }
    return report.diagnostics
      .filter((d) => d.code === 'effect(no-gen-wrapper)')
      .map((d) => d.labels[0]?.span.line ?? 0)
      .sort((a, b) => a - b)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('flags named arrow functions that only return Effect.gen', () => {
  expect(flagged()).toEqual([2, 3, 4, 5, 6])
})

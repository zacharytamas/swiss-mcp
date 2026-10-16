import { expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

test('a startup failure is reported on stderr and leaves stdout free of non-JSON-RPC lines', async () => {
  // Lives next to main.ts so it resolves the project's dependencies; launched exactly as the real server is.
  const entry = join(import.meta.dir, `.startup-failure-${process.pid}.ts`)
  await Bun.write(
    entry,
    `import { Effect, Layer } from 'effect'
import { launch } from './main.ts'
launch(Layer.effectDiscard(Effect.fail(new Error('boom at startup'))))
`,
  )
  try {
    const proc = Bun.spawn(['bun', entry], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect({
      stdout,
      exitCode,
      reportsOnStderr: stderr.includes('boom at startup'),
    }).toEqual({ stdout: '', exitCode: 1, reportsOnStderr: true })
  } finally {
    await rm(entry, { force: true })
  }
})

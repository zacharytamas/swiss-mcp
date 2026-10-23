import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The interval keeps the fake alive after stdin closes, the way the real server stays alive. It is the fake's
// lifetime, not a wait in the test.
const fakeServer = `
await Bun.write(process.env.PID_FILE, String(process.pid))
setInterval(() => {}, 60_000)
const mode = process.env.MODE
if (mode === 'garbage') console.log('not json')
if (mode === 'close') require('node:fs').closeSync(1)
`

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-call-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/main.ts'), fakeServer)
})
afterAll(() => {
  for (const f of new Bun.Glob('*.pid').scanSync(dir)) {
    try {
      process.kill(Number(readFileSync(join(dir, f), 'utf8')))
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true })
})

// The fake inherits mcp-call's stderr, so the pipe closes only after both processes have exited. A surviving server
// keeps it open and the test fails on its timeout. The PID file proves the fake started, so the close is not vacuous.
// Probing the PID instead is wrong on Linux, where a killed server stays a zombie until its new parent reaps it.
const run = async (mode: string, args: string[]) => {
  const pidFile = join(dir, `${mode}.pid`)
  const proc = Bun.spawn(
    ['bun', join(import.meta.dir, 'mcp-call.ts'), ...args],
    {
      cwd: dir,
      // A short deadline on the other modes would turn a slow start into exit 124.
      env: {
        ...process.env,
        MODE: mode,
        PID_FILE: pidFile,
        MCP_CALL_TIMEOUT_MS: mode === 'silent' ? '300' : '30000',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  )
  const [code] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])
  return { code, serverStarted: existsSync(pidFile) }
}

test('arguments that are not JSON exit 2 before any server starts', async () => {
  expect(await run('unused', ['due_list_reminders', '{bad'])).toEqual({
    code: 2,
    serverStarted: false,
  })
})

test.each([
  ['garbage', 1],
  ['close', 1],
  ['silent', 124],
])('a server that is %s gets exit %i and has exited', async (mode, code) => {
  expect(await run(mode, ['due_list_reminders', '{}'])).toEqual({
    code,
    serverStarted: true,
  })
})

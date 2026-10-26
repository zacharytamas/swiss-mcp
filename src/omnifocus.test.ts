import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  Schema,
  Sink,
  Stream,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { requestOnce } from '../scripts/mcp-client.ts'
import { OmniFocusTimedOut } from './omnifocus-errors.ts'
import { JXA, OmniFocus } from './omnifocus.ts'

const bytes = (value: string) => Stream.succeed(new TextEncoder().encode(value))

const handle = (
  stdout: string,
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>,
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: bytes(stdout),
    stderr: bytes(''),
    all: bytes(stdout),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })

// Every run echoes its source back as a JSON string after a short wait, recording what it was given and how many
// runs overlapped.
const slowEcho = () => {
  const spawned: Array<{ args: ReadonlyArray<string>; stdin: unknown }> = []
  let running = 0
  let mostAtOnce = 0
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die('piped command')
        spawned.push({ args: command.args, stdin: command.options.stdin })
        running++
        mostAtOnce = Math.max(mostAtOnce, running)
        const done = Effect.sleep('20 millis').pipe(
          Effect.andThen(
            Effect.sync(() => {
              running--
              return ChildProcessSpawner.ExitCode(0)
            }),
          ),
        )
        return handle(JSON.stringify(command.args.at(-1)), done)
      }),
    ),
  )
  return { spawned, mostAtOnce: () => mostAtOnce, layer }
}

// A run that never exits until its scope closes, which marks it killed.
const hanging = () => {
  let killed = false
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<number>()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            killed = true
          }).pipe(Effect.andThen(Deferred.succeed(done, 143))),
        )
        return handle(
          '',
          Effect.map(Deferred.await(done), ChildProcessSpawner.ExitCode),
        )
      }),
    ),
  )
  return { killed: () => killed, layer }
}

const runWith = <A, E>(
  layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  effect: Effect.Effect<A, E, OmniFocus>,
) =>
  Effect.runPromiseExit(
    effect.pipe(Effect.provide(OmniFocus.layer), Effect.provide(layer)),
  )

describe('OmniFocus.evaluate', () => {
  test('hands the source to OmniFocus through osascript as one argument, with stdin closed', async () => {
    const cli = slowEcho()

    const exit = await runWith(
      cli.layer,
      Effect.flatMap(OmniFocus, (of) =>
        of.evaluate('echo', 'say "hi"\n', Schema.String),
      ),
    )

    expect(exit).toEqual(Exit.succeed('say "hi"\n'))
    expect(cli.spawned).toEqual([
      {
        args: ['-l', 'JavaScript', '-e', JXA, 'say "hi"\n'],
        stdin: 'ignore',
      },
    ])
  })

  test('runs one call at a time', async () => {
    const cli = slowEcho()

    const exit = await runWith(
      cli.layer,
      Effect.flatMap(OmniFocus, (of) =>
        Effect.all(
          ['a', 'b', 'c'].map((s) => of.evaluate('echo', s, Schema.String)),
          { concurrency: 'unbounded' },
        ),
      ),
    )

    expect(exit).toEqual(Exit.succeed(['a', 'b', 'c']))
    expect(cli.mostAtOnce()).toBe(1)
  })

  test('gives up after the timeout, kills osascript, and warns the call may still have run', async () => {
    const cli = hanging()

    const exit = await runWith(
      cli.layer,
      Effect.flatMap(OmniFocus, (of) =>
        of.evaluate('snapshot', 'x', Schema.String, '20 millis'),
      ),
    )

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
      new OmniFocusTimedOut({
        timeoutMs: 20,
        message:
          'OmniFocus snapshot timed out after 20 ms. It may still have run, so do not retry blindly. A pending macOS Automation permission prompt or an open dialog in OmniFocus is the usual cause.',
      }),
    )
    expect(cli.killed()).toBe(true)
  })
})

let dir = ''

// A stand-in for /usr/bin/osascript: records its flags, the JXA and the OmniJS source it was given, then answers with
// $dir/reply on stdout, $dir/stderr on stderr and the exit code in $dir/exit.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'swiss-fake-osascript-'))
  await Bun.write(
    join(dir, 'osascript'),
    `#!/bin/sh
printf '%s ' "$1" "$2" "$3" > "${dir}/flags"
printf '%s' "$4" > "${dir}/jxa"
printf '%s' "$5" > "${dir}/source.js"
cat "${dir}/stderr" >&2
cat "${dir}/reply"
exit "$(cat "${dir}/exit")"
`,
  )
  await chmod(join(dir, 'osascript'), 0o755)
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const request = async (
  method: string,
  params: object,
  { reply = '{}', stderr = '', exit = 0 } = {},
) => {
  await Bun.write(join(dir, 'reply'), reply)
  await Bun.write(join(dir, 'stderr'), stderr)
  await Bun.write(join(dir, 'exit'), String(exit))
  await rm(join(dir, 'source.js'), { force: true })
  return requestOnce(method, params, {
    protocolVersion: '2025-11-25',
    env: { ...process.env, SWISS_OSASCRIPT_BIN: join(dir, 'osascript') },
  })
}

const callTool = (
  name: string,
  args: object,
  answer: { reply?: string; stderr?: string; exit?: number } = {},
) => request('tools/call', { name, arguments: args }, answer)

// The OmniJS program OmniFocus would have run, and the arguments it carries on its second-to-last line.
const sent = async () => {
  const source = await Bun.file(join(dir, 'source.js')).text()
  return { source, args: JSON.parse(source.split('\n').at(-2) ?? '') }
}

const failure = (reply: Awaited<ReturnType<typeof callTool>>) => {
  expect(reply.result.isError).toBe(true)
  return JSON.parse(reply.result.content[0].text)
}

const task = (id: string, name: string, status: string, tags: string[]) => ({
  id,
  name,
  note: '',
  status,
  deferDate: null,
  dueDate: null,
  plannedDate: null,
  tags,
  project: null,
  repeat: null,
})
const MORNING_TASK = task('t1', 'Stretch', 'Available', ['Slot/Morning'])
const HOME_TASKS = [
  task('t2', 'Fix the gate', 'Blocked', ['Home']),
  task('t3', 'Water plants', 'Next', ['Home']),
]
const perspective = (id: string, name: string, rules: unknown) => ({
  id,
  name,
  rules,
  aggregation: 'all',
})
const PERSPECTIVES = [
  perspective('p1', 'Morning', [
    { actionAvailability: 'available' },
    { actionHasAnyOfTags: ['slot'] },
  ]),
  perspective('p2', 'Home', [
    { actionAvailability: 'remaining' },
    { actionHasAnyOfTags: ['home'] },
  ]),
  perspective('p3', 'Completed', [{ actionAvailability: 'completed' }]),
  perspective('p4', 'Twice', [{ actionAvailability: 'available' }]),
  perspective('p5', 'Twice', [{ actionAvailability: 'remaining' }]),
]
const SNAPSHOT = JSON.stringify({
  tags: [
    { id: 'slot', name: 'Slot', parentId: null },
    { id: 'morning', name: 'Morning', parentId: 'slot' },
    { id: 'home', name: 'Home', parentId: null },
  ],
  tasks: [
    { ...MORNING_TASK, tagIds: ['morning'] },
    ...HOME_TASKS.map((t) => ({ ...t, tagIds: ['home'] })),
  ].map((t) => ({ ...t, leaf: true, effectiveDeferDate: null })),
  perspectives: PERSPECTIVES,
})

const strange = `Call "Dad" about Zoë's \\ backslash\nsecond line 🎉`

describe('OmniFocus tools over MCP', () => {
  test('tools/list marks what each tool does and tells clients the local date format', async () => {
    const reply = await request('tools/list', {})
    const tools: Array<{
      name: string
      annotations: { readOnlyHint: boolean; destructiveHint: boolean }
      inputSchema: object
    }> = reply.result.tools.filter((t: { name: string }) =>
      t.name.startsWith('omnifocus_'),
    )

    expect(
      tools.map((t) => [
        t.name,
        t.annotations.readOnlyHint,
        t.annotations.destructiveHint,
        JSON.stringify(t.inputSchema).includes('YYYY-MM-DD HH:mm'),
      ]),
    ).toEqual([
      ['omnifocus_list_perspectives', true, false, false],
      ['omnifocus_perspective_tasks', true, false, false],
      ['omnifocus_list_tags', true, false, false],
      ['omnifocus_create_task', false, false, true],
      ['omnifocus_update_task', false, true, true],
      ['omnifocus_complete_task', false, true, true],
    ])
  })

  test('omnifocus_list_perspectives says which perspectives are supported and why not', async () => {
    const reply = await callTool(
      'omnifocus_list_perspectives',
      {},
      { reply: JSON.stringify({ perspectives: PERSPECTIVES }) },
    )

    expect(reply.result.structuredContent).toEqual({
      perspectives: [
        { id: 'p1', name: 'Morning', supported: true },
        { id: 'p2', name: 'Home', supported: true },
        {
          id: 'p3',
          name: 'Completed',
          supported: false,
          unsupportedReason:
            'rule actionAvailability: "completed" is not supported',
        },
        { id: 'p4', name: 'Twice', supported: true },
        { id: 'p5', name: 'Twice', supported: true },
      ],
    })
  })

  test("omnifocus_perspective_tasks returns the perspective's tasks in snapshot order, in the task shape", async () => {
    const morning = await callTool(
      'omnifocus_perspective_tasks',
      { perspective: 'Morning' },
      { reply: SNAPSHOT },
    )
    const home = await callTool(
      'omnifocus_perspective_tasks',
      { perspective: 'Home' },
      { reply: SNAPSHOT },
    )

    expect(morning.result.structuredContent).toEqual({
      perspective: 'Morning',
      tasks: [MORNING_TASK],
    })
    expect(home.result.structuredContent.tasks).toEqual(HOME_TASKS)
  })

  test.each([
    ['Nope', 'OmniFocusPerspectiveNotFound', 'No OmniFocus custom perspective'],
    [
      'Twice',
      'OmniFocusPerspectiveAmbiguous',
      '2 OmniFocus custom perspectives',
    ],
    [
      'Completed',
      'OmniFocusPerspectiveUnsupported',
      'rule actionAvailability: "completed" is not supported',
    ],
  ])('the perspective %s is %s', async (name, error, message) => {
    const reply = await callTool(
      'omnifocus_perspective_tasks',
      { perspective: name },
      { reply: SNAPSHOT },
    )

    const { error: tag, message: text } = failure(reply)
    expect(tag).toBe(error)
    expect(text).toContain(message)
  })

  test('a task name with quotes, a backslash, a newline and emoji reaches OmniFocus intact as JSON', async () => {
    const args = {
      name: strange,
      note: strange,
      tags: ['Slot/Morning', strange],
      deferDate: '2026-10-27',
      repeat: { rule: 'FREQ=DAILY' },
    }
    const created = { ...task('t9', strange, 'Available', []), note: strange }

    const reply = await callTool('omnifocus_create_task', args, {
      reply: JSON.stringify({ task: created }),
    })

    const { source, args: received } = await sent()
    expect(received).toEqual(args)
    expect(() => new Script(source)).not.toThrow()
    expect(await Bun.file(join(dir, 'flags')).text()).toBe('-l JavaScript -e ')
    expect(await Bun.file(join(dir, 'jxa')).text()).toBe(JXA)
    expect(reply.result.structuredContent).toEqual({ task: created })
  })

  test('omnifocus_update_task sends null for what to clear and leaves out what to keep', async () => {
    await callTool(
      'omnifocus_update_task',
      { id: 't1', deferDate: null, repeat: { catchUp: true } },
      { reply: JSON.stringify({ task: MORNING_TASK }) },
    )

    expect((await sent()).args).toEqual({
      id: 't1',
      deferDate: null,
      repeat: { catchUp: true },
    })
  })

  test("a script's refusal is a tool error with its tag and message", async () => {
    const refusal = {
      error: 'OmniFocusOccurrenceMoved',
      message:
        '"Stretch" is now deferred to 2026-10-28 06:00, not 2026-10-27 06:00.',
    }

    const reply = await callTool(
      'omnifocus_complete_task',
      { id: 't1', deferDate: '2026-10-27 06:00' },
      { reply: JSON.stringify(refusal) },
    )

    expect(failure(reply)).toEqual(refusal)
    expect((await sent()).args).toEqual({
      id: 't1',
      deferDate: '2026-10-27 06:00',
    })
  })

  test('osascript failing is OmniFocusFailed with its stderr and, for a denied Automation permission, where to allow it', async () => {
    const reply = await callTool(
      'omnifocus_list_tags',
      {},
      {
        stderr:
          'execution error: Not authorized to send Apple events to OmniFocus. (-1743)\n',
        exit: 1,
      },
    )

    expect(failure(reply)).toEqual({
      error: 'OmniFocusFailed',
      message:
        'OmniFocus list tags failed (exit 1): execution error: Not authorized to send Apple events to OmniFocus. (-1743) Allow it to control OmniFocus in System Settings > Privacy & Security > Automation.',
    })
  })

  test.each([
    ['output that is not JSON', 'not json {'],
    ['JSON in the wrong shape', '{"tags":[{"id":1}]}'],
    ['an unknown refusal', '{"error":"Nope","message":"x"}'],
  ])('%s is OmniFocusOutputInvalid', async (_, output) => {
    const reply = await callTool('omnifocus_list_tags', {}, { reply: output })

    expect(failure(reply).error).toBe('OmniFocusOutputInvalid')
  })

  test.each([
    ['2026-02-30', 'does not exist'],
    ['2026-11-02 24:00', 'does not exist'],
    ['2026-11-02T09:30', 'YYYY-MM-DD'],
  ])(
    'rejects the date %s before OmniFocus is called',
    async (deferDate, expected) => {
      const reply = await callTool('omnifocus_create_task', {
        name: 'x',
        deferDate,
      })

      const message: string =
        reply.error?.message ?? reply.result?.content?.[0]?.text ?? ''
      expect(message).toContain(expected)
      expect(await Bun.file(join(dir, 'source.js')).exists()).toBe(false)
    },
  )
})

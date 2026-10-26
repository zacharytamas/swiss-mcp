import { describe, expect, test } from 'bun:test'
import { BunFileSystem } from '@effect/platform-bun'
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Sink,
  Stream,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { Focus } from './focus.ts'
import {
  ShortcutFailed,
  ShortcutInputInvalid,
  ShortcutNotFound,
  ShortcutOutputInvalid,
  ShortcutTimedOut,
} from './shortcuts-errors.ts'
import { parseListing, type ShortcutContract, Shortcuts } from './shortcuts.ts'

const ID = '46CFA397-9F0C-4CE9-92B1-3C92D17C8EB3'
const LISTING = `Log Water (11111111-1111-4111-8111-111111111111)\nswiss-json (${ID})\n`
const Payload = Schema.Struct({ greeting: Schema.String, count: Schema.Number })
const contract: ShortcutContract<typeof Payload, typeof Payload> = {
  name: 'swiss-json',
  input: Payload,
  output: Payload,
}

type Reply = {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}
type Spawned = {
  readonly args: ReadonlyArray<string>
  readonly stdin: unknown
  readonly inputJson?: string
}

const bytes = (value: string) => Stream.succeed(new TextEncoder().encode(value))

const handleFor = (reply: Reply) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: bytes(reply.stdout),
    stderr: bytes(reply.stderr),
    all: bytes(reply.stdout + reply.stderr),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })

// Answers `list` with LISTING and `run` with `onRun`, recording every spawn and the JSON Shortcuts would receive.
const fakeCli = (onRun: (inputJson: string) => Reply, listing = LISTING) => {
  const spawned: Array<Spawned> = []
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die('piped command')
        const { args, options } = command
        if (args[0] === 'list') {
          spawned.push({ args, stdin: options.stdin })
          return handleFor({ stdout: listing, stderr: '', code: 0 })
        }
        const inputJson = yield* Effect.promise(() =>
          Bun.file(args[3] ?? '').text(),
        )
        spawned.push({ args, stdin: options.stdin, inputJson })
        return handleFor(onRun(inputJson))
      }),
    ),
  )
  return { spawned, layer }
}

// Answers `list` with LISTING; `run` never exits until its scope closes, which marks it killed.
const hanging = () => {
  let killed = false
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (
          ChildProcess.isStandardCommand(command) &&
          command.args[0] === 'list'
        ) {
          return handleFor({ stdout: LISTING, stderr: '', code: 0 })
        }
        const done = yield* Deferred.make<number>()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            killed = true
          }).pipe(Effect.andThen(Deferred.succeed(done, 143))),
        )
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(2),
          exitCode: Effect.map(
            Deferred.await(done),
            ChildProcessSpawner.ExitCode,
          ),
          isRunning: Effect.map(Deferred.isDone(done), (settled) => !settled),
          kill: () => Effect.asVoid(Deferred.succeed(done, 143)),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })
      }),
    ),
  )
  return { killed: () => killed, layer }
}

// Reports each of `fronts` in turn as the frontmost app (the last one repeats), recording every call.
const fakeFocus = (...fronts: ReadonlyArray<string | undefined>) => {
  const calls: Array<string> = []
  let reads = 0
  const layer = Layer.succeed(Focus)(
    Focus.of({
      frontmost: Effect.sync(() => {
        const front = fronts[Math.min(reads++, fronts.length - 1)]
        calls.push(`frontmost ${front ?? 'none'}`)
        return Option.fromNullishOr(front)
      }),
      activate: (bundleId) =>
        Effect.sync(() => {
          calls.push(`activate ${bundleId}`)
        }),
    }),
  )
  return { calls, layer }
}

const runWith = <A, E>(
  layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  effect: Effect.Effect<A, E, Shortcuts>,
  focus: Layer.Layer<Focus> = fakeFocus().layer,
) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(Shortcuts.layer),
      Effect.provide(layer),
      Effect.provide(focus),
      Effect.provide(BunFileSystem.layer),
    ),
  )

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit

const call = (input: unknown, c: typeof contract = contract) =>
  Effect.flatMap(Shortcuts, (shortcuts) =>
    shortcuts.run(c, input as typeof Payload.Type),
  )

describe('parseListing', () => {
  test('keeps parentheses inside names, groups duplicates, and skips lines without an id', () => {
    const other = '11111111-1111-4111-8111-111111111111'
    expect<Record<string, ReadonlyArray<string>>>(
      Object.fromEntries(
        parseListing(
          `Stop (Driving) Task (${ID})\nnot a shortcut line\nswiss-due (${ID})\nswiss-due (${other})\n`,
        ),
      ),
    ).toEqual({ 'Stop (Driving) Task': [ID], 'swiss-due': [ID, other] })
  })
})

describe('Shortcuts.run', () => {
  test('resolves the name, sends exact JSON with stdin closed, and decodes typed output', async () => {
    const cli = fakeCli((json) => ({ stdout: json, stderr: '', code: 0 }))

    const exit = await runWith(
      cli.layer,
      call({ greeting: 'Zoë 🎉', count: 2 }),
    )

    expect(exit).toEqual(Exit.succeed({ greeting: 'Zoë 🎉', count: 2 }))
    expect(
      cli.spawned.map(({ args, stdin, inputJson }) => ({
        args: [...args],
        stdin,
        inputJson,
      })),
    ).toEqual([
      {
        args: ['list', '--show-identifiers'],
        stdin: 'ignore',
        inputJson: undefined,
      },
      {
        args: [
          'run',
          ID,
          '-i',
          cli.spawned[1]?.args[3] ?? '',
          '-o',
          '-',
          '--output-type',
          'public.plain-text',
        ],
        stdin: 'ignore',
        inputJson: '{"greeting":"Zoë 🎉","count":2}',
      },
    ])
  })

  test('refuses to guess when two shortcuts share the name', async () => {
    const cli = fakeCli(
      () => ({ stdout: '[]', stderr: '', code: 0 }),
      `swiss-json (${ID})\nswiss-json (11111111-1111-4111-8111-111111111111)\n`,
    )

    const exit = await runWith(cli.layer, call({ greeting: 'hi', count: 1 }))

    expect(failureOf(exit)).toEqual(
      new ShortcutFailed({
        shortcut: 'swiss-json',
        exitCode: -1,
        stderr: '',
        message:
          '2 shortcuts are named "swiss-json"; delete the extras in Shortcuts so the right one runs.',
      }),
    )
    expect(cli.spawned.map(({ args }) => args[0])).toEqual(['list'])
  })

  test('rejects an unknown input key before touching the CLI', async () => {
    const cli = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }))

    const exit = await runWith(
      cli.layer,
      call({ greeting: 'hi', count: 1, extra: true }),
    )

    expect(failureOf(exit)).toEqual(
      new ShortcutInputInvalid({
        shortcut: 'swiss-json',
        message:
          'swiss-json input is invalid: Expected no excess property\n  at ["extra"]',
      }),
    )
    expect(cli.spawned).toEqual([])
  })

  test('reports ShortcutNotFound when the name is not in the library', async () => {
    const cli = fakeCli(
      () => ({ stdout: '', stderr: '', code: 0 }),
      'Log Water (11111111-1111-4111-8111-111111111111)\n',
    )

    const exit = await runWith(cli.layer, call({ greeting: 'hi', count: 1 }))

    expect(failureOf(exit)).toEqual(
      new ShortcutNotFound({
        shortcut: 'swiss-json',
        message: 'The shortcut "swiss-json" is not installed in Shortcuts.',
      }),
    )
    expect(cli.spawned.map(({ args }) => args[0])).toEqual(['list'])
  })

  test('reports ShortcutFailed with stderr on a non-zero exit', async () => {
    const cli = fakeCli(() => ({ stdout: '', stderr: 'boom\n', code: 1 }))

    const exit = await runWith(cli.layer, call({ greeting: 'hi', count: 1 }))

    expect(failureOf(exit)).toEqual(
      new ShortcutFailed({
        shortcut: 'swiss-json',
        exitCode: 1,
        stderr: 'boom\n',
        message: 'swiss-json failed (exit 1): boom',
      }),
    )
  })

  test('decodes whenEmpty for empty output only when the contract opts in', async () => {
    const List = Schema.Array(Schema.String)
    const cli = fakeCli(() => ({ stdout: '\n', stderr: '', code: 0 }))
    const run = (whenEmpty?: string) =>
      Effect.flatMap(Shortcuts, (shortcuts) =>
        shortcuts.run(
          {
            name: 'swiss-json',
            input: Payload,
            output: List,
            ...(whenEmpty === undefined ? {} : { whenEmpty }),
          },
          { greeting: 'hi', count: 1 },
        ),
      )

    expect(await runWith(cli.layer, run('[]'))).toEqual(Exit.succeed([]))
    expect(failureOf(await runWith(cli.layer, run()))).toBeInstanceOf(
      ShortcutOutputInvalid,
    )
  })

  test('reports ShortcutOutputInvalid when Shortcuts passes raw text through', async () => {
    const cli = fakeCli(() => ({ stdout: 'not json {', stderr: '', code: 0 }))

    const exit = await runWith(cli.layer, call({ greeting: 'hi', count: 1 }))

    expect(failureOf(exit)).toEqual(
      new ShortcutOutputInvalid({
        shortcut: 'swiss-json',
        output: 'not json {',
        message:
          'swiss-json ran, but its output is invalid, so any changes it makes have already happened: Expected a valid JSON string',
      }),
    )
  })

  test('reports ShortcutTimedOut and kills a run that never exits', async () => {
    const cli = hanging()

    const exit = await runWith(
      cli.layer,
      call({ greeting: 'hi', count: 1 }, { ...contract, timeout: '20 millis' }),
    )

    expect(failureOf(exit)).toEqual(
      new ShortcutTimedOut({
        shortcut: 'swiss-json',
        timeoutMs: 20,
        message:
          'swiss-json timed out after 20 ms. It may still have run, so do not retry blindly. A pending macOS permission prompt is the usual cause.',
      }),
    )
    expect(cli.killed()).toBe(true)
  })
})

describe('Shortcuts.run with stealsFocus', () => {
  const DUE = 'com.dueapps.duemac-setapp'
  const stealing = { ...contract, stealsFocus: [DUE, 'com.phocusllp.duemac'] }
  const echo = fakeCli((json) => ({ stdout: json, stderr: '', code: 0 }))
  const runStealing = async (
    focus: ReturnType<typeof fakeFocus>,
    cli: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = echo.layer,
    c: typeof contract = stealing,
  ) => {
    const exit = await runWith(
      cli,
      call({ greeting: 'hi', count: 1 }, c),
      focus.layer,
    )
    return {
      exit,
      activated: focus.calls.filter((line) => line.startsWith('activate')),
    }
  }

  test('hands focus back when a thief took it', async () => {
    const { exit, activated } = await runStealing(
      fakeFocus('com.t3tools.t3code', DUE),
    )

    expect(exit).toEqual(Exit.succeed({ greeting: 'hi', count: 1 }))
    expect(activated).toEqual(['activate com.t3tools.t3code'])
  })

  test('recognises every listed thief', async () => {
    const { activated } = await runStealing(
      fakeFocus('com.t3tools.t3code', 'com.phocusllp.duemac'),
    )

    expect(activated).toEqual(['activate com.t3tools.t3code'])
  })

  test('leaves an app the user switched to in front', async () => {
    const { activated } = await runStealing(
      fakeFocus('com.t3tools.t3code', 'com.apple.Safari'),
    )

    expect(activated).toEqual([])
  })

  test('leaves the thief in front when it was already there', async () => {
    const { activated } = await runStealing(fakeFocus(DUE, DUE))

    expect(activated).toEqual([])
  })

  test('does nothing when the app in front before the run is unknown', async () => {
    const { activated } = await runStealing(fakeFocus(undefined, DUE))

    expect(activated).toEqual([])
  })

  test('hands focus back when the run fails', async () => {
    const failing = fakeCli(() => ({ stdout: '', stderr: 'boom\n', code: 1 }))

    const { exit, activated } = await runStealing(
      fakeFocus('com.t3tools.t3code', DUE),
      failing.layer,
    )

    expect(failureOf(exit)).toBeInstanceOf(ShortcutFailed)
    expect(activated).toEqual(['activate com.t3tools.t3code'])
  })

  test('hands focus back when the run times out', async () => {
    const { exit, activated } = await runStealing(
      fakeFocus('com.t3tools.t3code', DUE),
      hanging().layer,
      { ...stealing, timeout: '20 millis' },
    )

    expect(failureOf(exit)).toBeInstanceOf(ShortcutTimedOut)
    expect(activated).toEqual(['activate com.t3tools.t3code'])
  })

  test('never touches Focus for a contract without stealsFocus, or with none listed', async () => {
    for (const c of [contract, { ...contract, stealsFocus: [] }]) {
      const focus = fakeFocus('com.t3tools.t3code', DUE)

      await runStealing(focus, echo.layer, c)

      expect(focus.calls).toEqual([])
    }
  })
})

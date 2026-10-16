import { describe, expect, test } from 'bun:test'
import { BunFileSystem } from '@effect/platform-bun'
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
import {
  parseListing,
  type ShortcutContract,
  ShortcutFailed,
  ShortcutInputInvalid,
  ShortcutNotFound,
  ShortcutOutputInvalid,
  Shortcuts,
  ShortcutTimedOut,
} from './shortcuts.ts'

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

const runWith = <A, E>(
  layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  effect: Effect.Effect<A, E, Shortcuts>,
) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(Shortcuts.layer),
      Effect.provide(layer),
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
    let killed = false
    const hanging = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
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

    const exit = await runWith(
      hanging,
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
    expect(killed).toBe(true)
  })
})

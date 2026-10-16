import { describe, expect, test } from 'bun:test'
import { BunFileSystem } from '@effect/platform-bun'
import { Deferred, Effect, Exit, Layer, Schema, Sink, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import {
  type ShortcutContract,
  ShortcutFailed,
  ShortcutId,
  ShortcutInputInvalid,
  ShortcutNotFound,
  ShortcutOutputInvalid,
  Shortcuts,
  ShortcutTimedOut,
} from './shortcuts.ts'

const ID = '46CFA397-9F0C-4CE9-92B1-3C92D17C8EB3'
const Payload = Schema.Struct({ greeting: Schema.String, count: Schema.Number })
const contract: ShortcutContract<typeof Payload, typeof Payload> = {
  name: 'swiss-json',
  id: Schema.decodeUnknownSync(ShortcutId)(ID),
  input: Payload,
  output: Payload,
}

const encoder = new TextEncoder()
const text = (value: string) => Stream.succeed(encoder.encode(value))

type Reply = {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

const fakeLayer = (
  script: (command: ChildProcess.Command) => Effect.Effect<Reply>,
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) {
          return yield* Effect.die('expected a standard command')
        }
        const reply = yield* script(command)
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: text(reply.stdout),
          stderr: text(reply.stderr),
          all: text(`${reply.stdout}${reply.stderr}`),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })
      }),
    ),
  )

const run = <A, E>(effect: Effect.Effect<A, E, Shortcuts>) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(Shortcuts.layer),
      Effect.provide(Layer.unwrap(Effect.sync(() => fakeLayer(script)))),
      Effect.provide(BunFileSystem.layer),
    ),
  )

let script: (command: ChildProcess.Command) => Effect.Effect<Reply>

const calls: Array<ReadonlyArray<string>> = []

const installed = (present: boolean): Reply => ({
  stdout: present
    ? `swiss-json (${ID})\n`
    : 'other (11111111-1111-4111-8111-111111111111)\n',
  stderr: '',
  code: 0,
})

describe('Shortcuts.run', () => {
  test('decodes the shortcut output and writes the exact input JSON', async () => {
    calls.length = 0
    script = (command) => {
      if (!ChildProcess.isStandardCommand(command))
        return Effect.die('not standard')
      calls.push(command.args)
      expect(command.options.stdin).toBe('ignore')
      if (command.args[0] === 'list') return Effect.succeed(installed(true))
      const inputPath = command.args[3]
      if (inputPath === undefined) return Effect.die('missing input path')
      return Effect.promise(() => Bun.file(inputPath).text()).pipe(
        Effect.map((json) => ({ stdout: json, stderr: '', code: 0 })),
      )
    }

    const exit = await run(
      Effect.flatMap(Shortcuts, (shortcuts) =>
        shortcuts.run(contract, { greeting: 'héllo', count: 2 }),
      ),
    )

    expect(Exit.isSuccess(exit) ? exit.value : exit).toEqual({
      greeting: 'héllo',
      count: 2,
    })
    expect(calls[0]).toEqual([
      'run',
      ID,
      '-i',
      calls[0]?.[3] ?? '',
      '-o',
      '-',
      '--output-type',
      'public.plain-text',
    ])
  })

  test('rejects an excess input key before spawning', async () => {
    calls.length = 0
    script = () => {
      calls.push(['spawned'])
      return Effect.succeed(installed(true))
    }

    const exit = await run(
      Effect.flatMap(Shortcuts, (shortcuts) =>
        shortcuts.run(contract, {
          greeting: 'hi',
          count: 1,
          extra: true,
        } as never),
      ),
    )

    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
    expect(error && 'error' in error ? error.error : exit).toEqual(
      new ShortcutInputInvalid({
        shortcut: 'swiss-json',
        message:
          'swiss-json input is invalid: Expected no excess property\n  at ["extra"]',
      }),
    )
    expect(calls).toEqual([])
  })

  test('reports ShortcutNotFound when the id is absent from the listing', async () => {
    script = (command) =>
      Effect.succeed(
        ChildProcess.isStandardCommand(command) && command.args[0] === 'list'
          ? installed(false)
          : { stdout: '', stderr: 'Error: missing\n', code: 1 },
      )

    const exit = await run(
      Effect.flatMap(Shortcuts, (shortcuts) =>
        shortcuts.run(contract, { greeting: 'hi', count: 1 }),
      ),
    )

    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
    expect(error && 'error' in error ? error.error : exit).toEqual(
      new ShortcutNotFound({
        shortcut: 'swiss-json',
        message: `swiss-json (${ID}) is not installed in Shortcuts`,
      }),
    )
  })

  test('reports ShortcutFailed with stderr when the id is installed', async () => {
    script = (command) =>
      Effect.succeed(
        ChildProcess.isStandardCommand(command) && command.args[0] === 'list'
          ? installed(true)
          : { stdout: '', stderr: 'boom\n', code: 1 },
      )

    const exit = await run(
      Effect.flatMap(Shortcuts, (shortcuts) =>
        shortcuts.run(contract, { greeting: 'hi', count: 1 }),
      ),
    )

    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
    expect(error && 'error' in error ? error.error : exit).toEqual(
      new ShortcutFailed({
        shortcut: 'swiss-json',
        exitCode: 1,
        stderr: 'boom\n',
        message: 'swiss-json failed (exit 1): boom',
      }),
    )
  })

  test('reports ShortcutOutputInvalid when stdout is not the output schema', async () => {
    script = () => Effect.succeed({ stdout: 'not json {', stderr: '', code: 0 })

    const exit = await run(
      Effect.flatMap(Shortcuts, (shortcuts) =>
        shortcuts.run(contract, { greeting: 'hi', count: 1 }),
      ),
    )

    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
    expect(error && 'error' in error ? error.error : exit).toEqual(
      new ShortcutOutputInvalid({
        shortcut: 'swiss-json',
        output: 'not json {',
        message: 'swiss-json output is invalid: Expected a valid JSON string',
      }),
    )
  })

  test('reports ShortcutTimedOut when the process never exits', async () => {
    const hanging = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
      ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<number>()
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.map(Deferred.await(done), (code) =>
              ChildProcessSpawner.ExitCode(code),
            ),
            isRunning: Effect.map(Deferred.isDone(done), (settled) => !settled),
            kill: () => Deferred.succeed(done, 143).pipe(Effect.asVoid),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
        }),
      ),
    )
    const timed: ShortcutContract<typeof Payload, typeof Payload> = {
      ...contract,
      timeout: '10 millis',
    }

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Shortcuts, (shortcuts) =>
        shortcuts.run(timed, { greeting: 'hi', count: 1 }),
      ).pipe(
        Effect.provide(Shortcuts.layer),
        Effect.provide(hanging),
        Effect.provide(BunFileSystem.layer),
      ),
    )

    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
    expect(error && 'error' in error ? error.error : exit).toEqual(
      new ShortcutTimedOut({
        shortcut: 'swiss-json',
        timeoutMs: 10,
        message:
          'swiss-json timed out after 10 ms. It may still have run, so do not retry blindly. A pending macOS permission prompt is the usual cause.',
      }),
    )
  })
})

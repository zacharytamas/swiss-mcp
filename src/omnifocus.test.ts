import { describe, expect, test } from 'bun:test'
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

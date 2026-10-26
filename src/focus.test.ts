import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Option, Sink, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { Focus, parseBundleId } from './focus.ts'

const ASN = 'ASN:0x0-0x6c0fc09:'
const UNLOCKED = `[ NULL ]  ASN:0x0-0x6c0fc09: (in front)
    bundleID="com.t3tools.t3code"
    bundle path=[ NULL ]
    executable path=[ NULL ]
 !cgsConnection !signalled type=[ NULL ]  flavor=[ NULL ]  Version=[ NULL ]  Arch=!!none
`
const LOCKED = UNLOCKED.replace('"com.t3tools.t3code"', '[ NULL ] ')

type Reply = {
  readonly stdout: string
  readonly code: number
  readonly hang?: boolean
}

const bytes = (value: string) => Stream.succeed(new TextEncoder().encode(value))

// Answers each command line with `reply`, recording it; a reply of `undefined` makes the spawn die, standing in for
// a missing binary.
const fakeSpawner = (reply: (line: string) => Reply | undefined) => {
  const spawned: Array<string> = []
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die('piped command')
        const line = [command.command, ...command.args].join(' ')
        spawned.push(line)
        const r = reply(line)
        if (r === undefined) return yield* Effect.die(new Error('ENOENT'))
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: r.hang
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(r.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: bytes(r.stdout),
          stderr: Stream.empty,
          all: bytes(r.stdout),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })
      }),
    ),
  )
  return { spawned, layer }
}

const lsappinfo = (front: Reply | undefined, info: Reply | undefined) =>
  fakeSpawner((line) =>
    line === '/usr/bin/lsappinfo front'
      ? front
      : line === `/usr/bin/lsappinfo info -only bundleid ${ASN}`
        ? info
        : { stdout: '', code: 1 },
  )

const run = <A>(
  layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  effect: Effect.Effect<A, never, Focus>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Focus.layer), Effect.provide(layer)),
  )

const frontmost = Effect.flatMap(Focus, (focus) => focus.frontmost)

describe('parseBundleId', () => {
  test('reads the bundle id, and none while the screen is locked', () => {
    expect(parseBundleId(UNLOCKED)).toEqual(Option.some('com.t3tools.t3code'))
    expect(parseBundleId(LOCKED)).toEqual(Option.none())
    expect(parseBundleId('')).toEqual(Option.none())
  })
})

describe('Focus.frontmost', () => {
  test('looks up the front ASN, then its bundle id', async () => {
    const cli = lsappinfo(
      { stdout: `${ASN}\n`, code: 0 },
      { stdout: UNLOCKED, code: 0 },
    )

    expect(await run(cli.layer, frontmost)).toEqual(
      Option.some('com.t3tools.t3code'),
    )
    expect(cli.spawned).toEqual([
      '/usr/bin/lsappinfo front',
      `/usr/bin/lsappinfo info -only bundleid ${ASN}`,
    ])
  })

  test('is none instead of failing when lsappinfo is missing, exits non-zero, or has no bundle id', async () => {
    const cases = [
      lsappinfo(undefined, undefined),
      lsappinfo({ stdout: '', code: 1 }, undefined),
      lsappinfo({ stdout: '\n', code: 0 }, undefined),
      lsappinfo({ stdout: ASN, code: 0 }, { stdout: '', code: 1 }),
      lsappinfo({ stdout: ASN, code: 0 }, { stdout: LOCKED, code: 0 }),
    ]

    for (const cli of cases) {
      expect(await run(cli.layer, frontmost)).toEqual(Option.none())
    }
  })

  test('gives up on an lsappinfo that never exits', async () => {
    const cli = lsappinfo({ stdout: ASN, code: 0, hang: true }, undefined)

    expect(await run(cli.layer, frontmost)).toEqual(Option.none())
  })
})

describe('Focus.activate', () => {
  test('opens the app by bundle id and swallows failures', async () => {
    const ok = fakeSpawner(() => ({ stdout: '', code: 0 }))
    const missing = fakeSpawner(() => undefined)
    const activate = Effect.flatMap(Focus, (focus) =>
      focus.activate('com.t3tools.t3code'),
    )

    await run(ok.layer, activate)
    await run(missing.layer, activate)

    expect(ok.spawned).toEqual(['/usr/bin/open -b com.t3tools.t3code'])
    expect(missing.spawned).toEqual(['/usr/bin/open -b com.t3tools.t3code'])
  })
})

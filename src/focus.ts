import { Context, Effect, Layer, Option, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

// `lsappinfo info -only bundleid <ASN>` prints `bundleID="com.example.app"`, or `bundleID=[ NULL ]` for loginwindow
// while the screen is locked.
export const parseBundleId = (info: string): Option.Option<string> =>
  Option.fromNullishOr(/bundleID="([^"]+)"/.exec(info)?.[1])

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  // The read after a run happens in a finalizer, which nothing else would cut short.
  const stdout = (bin: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(bin, args, { stdin: 'ignore', stderr: 'ignore' }),
        )
        const [out, code] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
          { concurrency: 'unbounded' },
        )
        return code === 0 ? Option.some(out) : Option.none<string>()
      }),
    ).pipe(Effect.timeout('1 second'))

  // `lsappinfo info -only bundleid front` prints nothing, so the front app's ASN is looked up first.
  const frontmost = Effect.gen(function* () {
    const asn = yield* stdout('/usr/bin/lsappinfo', ['front'])
    if (Option.isNone(asn) || asn.value.trim() === '') return Option.none()
    const info = yield* stdout('/usr/bin/lsappinfo', [
      'info',
      '-only',
      'bundleid',
      asn.value.trim(),
    ])
    return Option.flatMap(info, parseBundleId)
  }).pipe(Effect.catchCause(() => Effect.succeedNone))

  const activate = (bundleId: string) =>
    stdout('/usr/bin/open', ['-b', bundleId]).pipe(Effect.ignoreCause)

  return Focus.of({ frontmost, activate })
})

export class Focus extends Context.Service<
  Focus,
  {
    // The frontmost app's bundle id, or none when it can't be read (no lsappinfo, a locked screen).
    readonly frontmost: Effect.Effect<Option.Option<string>>
    readonly activate: (bundleId: string) => Effect.Effect<void>
  }
>()('swiss-mcp/Focus') {
  static readonly layer = Layer.effect(Focus, make)
}

// Runs `effect`, then hands focus back to the app that had it if one of `thieves` took it in the meantime. An app the
// user switched to themselves is left in front.
export const keepFocus = <A, E, R>(
  focus: Focus['Service'],
  thieves: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(focus.frontmost, (before) =>
    Effect.onExit(effect, () =>
      Effect.flatMap(focus.frontmost, (after) =>
        Option.isSome(before) &&
        Option.isSome(after) &&
        before.value !== after.value &&
        thieves.includes(after.value)
          ? focus.activate(before.value)
          : Effect.void,
      ),
    ),
  )

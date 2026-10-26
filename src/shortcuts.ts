import {
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Schema,
  Stream,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { Focus, keepFocus } from './focus.ts'
import {
  type ShortcutError,
  ShortcutFailed,
  ShortcutInputInvalid,
  ShortcutNotFound,
  ShortcutOutputInvalid,
  ShortcutTimedOut,
} from './shortcuts-errors.ts'
import { ShortcutId } from './shortcuts-schema.ts'

const OUTPUT_LIMIT = 4096

type JsonCodec = Schema.Codec<unknown, unknown, never, never>

export interface ShortcutContract<I extends JsonCodec, O extends JsonCodec> {
  readonly name: string
  readonly input: I
  readonly output: O
  readonly timeout?: Duration.Input
  // A shortcut whose last action produced nothing (e.g. a Find with no matches) prints nothing; this JSON is decoded
  // instead. Without it, empty output is ShortcutOutputInvalid.
  readonly whenEmpty?: string
  // Bundle ids of apps that bring themselves to the front while the shortcut runs; focus is handed back to the app that
  // had it.
  readonly stealsFocus?: ReadonlyArray<string>
}

// `shortcuts list --show-identifiers` prints `Name (UUID)`; names may themselves contain parentheses.
export const parseListing = (
  listing: string,
): ReadonlyMap<string, ReadonlyArray<ShortcutId>> => {
  const ids = new Map<string, Array<ShortcutId>>()
  for (const line of listing.split('\n')) {
    const match = /^(.*) \(([0-9A-Fa-f-]{36})\)$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue
    const same = ids.get(match[1]) ?? []
    same.push(ShortcutId.make(match[2]))
    ids.set(match[1], same)
  }
  return ids
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const focus = yield* Focus
  // Overridable so the whole server can be exercised against a fake CLI on machines without Shortcuts.
  const bin = yield* Config.String('SWISS_SHORTCUTS_BIN').pipe(
    Config.withDefault('/usr/bin/shortcuts'),
  )

  const exec = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(bin, args, { stdin: 'ignore' }),
        )
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: 'unbounded' },
        )
        return { stdout, stderr, code: Number(code) }
      }),
    )

  const resolve = Effect.fn('Shortcuts.resolve')(function* (
    shortcut: string,
  ): Effect.fn.Return<ShortcutId, ShortcutFailed | ShortcutNotFound> {
    const listing = yield* exec(['list', '--show-identifiers']).pipe(
      Effect.mapError(
        (cause) =>
          new ShortcutFailed({
            shortcut,
            exitCode: -1,
            stderr: '',
            message: `could not list shortcuts: ${cause.message}`,
          }),
      ),
    )
    if (listing.code !== 0) {
      return yield* new ShortcutFailed({
        shortcut,
        exitCode: listing.code,
        stderr: listing.stderr,
        message: `could not list shortcuts (exit ${listing.code}): ${listing.stderr.trim()}`,
      })
    }
    const [id, ...others] = parseListing(listing.stdout).get(shortcut) ?? []
    if (id === undefined) {
      return yield* new ShortcutNotFound({
        shortcut,
        message: `The shortcut "${shortcut}" is not installed in Shortcuts.`,
      })
    }
    if (others.length > 0) {
      return yield* new ShortcutFailed({
        shortcut,
        exitCode: -1,
        stderr: '',
        message: `${others.length + 1} shortcuts are named "${shortcut}"; delete the extras in Shortcuts so the right one runs.`,
      })
    }
    return id
  })

  const run = Effect.fn('Shortcuts.run')(function* <
    I extends JsonCodec,
    O extends JsonCodec,
  >(
    contract: ShortcutContract<I, O>,
    input: I['Type'],
  ): Effect.fn.Return<O['Type'], ShortcutError> {
    const shortcut = contract.name
    const failed = (exitCode: number, stderr: string, detail: string) =>
      new ShortcutFailed({
        shortcut,
        exitCode,
        stderr,
        message: `${shortcut} failed (exit ${exitCode}): ${detail}`,
      })

    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(contract.input),
      { onExcessProperty: 'error' },
    )(input).pipe(
      Effect.mapError(
        (cause) =>
          new ShortcutInputInvalid({
            shortcut,
            message: `${shortcut} input is invalid: ${cause.message}`,
          }),
      ),
    )

    const timeout = Duration.fromInputUnsafe(contract.timeout ?? '30 seconds')
    const result = yield* Effect.gen(function* () {
      const id = yield* resolve(shortcut)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: 'swiss-shortcut-',
          })
          const inputPath = `${directory}/input.json`
          yield* fs.writeFileString(inputPath, json)
          const running = exec([
            'run',
            id,
            '-i',
            inputPath,
            '-o',
            '-',
            '--output-type',
            'public.plain-text',
          ])
          return yield* contract.stealsFocus?.length
            ? keepFocus(focus, contract.stealsFocus, running)
            : running
        }),
      ).pipe(Effect.mapError((cause) => failed(-1, '', cause.message)))
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new ShortcutTimedOut({
              shortcut,
              timeoutMs: Duration.toMillis(timeout),
              message: `${shortcut} timed out after ${Duration.toMillis(timeout)} ms. It may still have run, so do not retry blindly. A pending macOS permission prompt is the usual cause.`,
            }),
          ),
      }),
    )

    if (result.code !== 0) {
      return yield* failed(
        result.code,
        result.stderr,
        result.stderr.trim() || 'no stderr',
      )
    }

    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(contract.output),
    )(
      result.stdout.trim() === '' && contract.whenEmpty !== undefined
        ? contract.whenEmpty
        : result.stdout,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ShortcutOutputInvalid({
            shortcut,
            output: result.stdout.slice(0, OUTPUT_LIMIT),
            message: `${shortcut} ran, but its output is invalid, so any changes it makes have already happened: ${cause.message}`,
          }),
      ),
    )
  })

  return Shortcuts.of({ run })
})

export class Shortcuts extends Context.Service<
  Shortcuts,
  {
    readonly run: <I extends JsonCodec, O extends JsonCodec>(
      contract: ShortcutContract<I, O>,
      input: I['Type'],
    ) => Effect.Effect<O['Type'], ShortcutError>
  }
>()('swiss-mcp/Shortcuts') {
  static readonly layer = Layer.effect(Shortcuts, make)
}

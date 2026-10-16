import {
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Schema,
  Stream,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

const SHORTCUTS = '/usr/bin/shortcuts'
const OUTPUT_LIMIT = 4096

export const ShortcutId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ShortcutId'),
)
export type ShortcutId = typeof ShortcutId.Type

type JsonCodec = Schema.Codec<unknown, unknown, never, never>

export interface ShortcutContract<I extends JsonCodec, O extends JsonCodec> {
  readonly name: string
  readonly id: ShortcutId
  readonly input: I
  readonly output: O
  readonly timeout?: Duration.Input
}

const fields = { shortcut: Schema.String, message: Schema.String }

export class ShortcutInputInvalid extends Schema.TaggedError<ShortcutInputInvalid>()(
  'ShortcutInputInvalid',
  fields,
) {}

export class ShortcutNotFound extends Schema.TaggedError<ShortcutNotFound>()(
  'ShortcutNotFound',
  fields,
) {}

export class ShortcutFailed extends Schema.TaggedError<ShortcutFailed>()(
  'ShortcutFailed',
  { ...fields, exitCode: Schema.Number, stderr: Schema.String },
) {}

export class ShortcutTimedOut extends Schema.TaggedError<ShortcutTimedOut>()(
  'ShortcutTimedOut',
  { ...fields, timeoutMs: Schema.Number },
) {}

export class ShortcutOutputInvalid extends Schema.TaggedError<ShortcutOutputInvalid>()(
  'ShortcutOutputInvalid',
  { ...fields, output: Schema.String },
) {}

export type ShortcutError =
  | ShortcutInputInvalid
  | ShortcutNotFound
  | ShortcutFailed
  | ShortcutTimedOut
  | ShortcutOutputInvalid

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem

  const exec = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(SHORTCUTS, args, { stdin: 'ignore' }),
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

  // The CLI's "not found" message is localized, so absence is confirmed from the listing instead.
  const isInstalled = (id: ShortcutId) =>
    exec(['list', '--show-identifiers']).pipe(
      Effect.map(
        ({ stdout, code }) =>
          code !== 0 ||
          stdout
            .split('\n')
            .some((line) =>
              line.toLowerCase().endsWith(`(${id.toLowerCase()})`),
            ),
      ),
      Effect.orElseSucceed(() => true),
    )

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
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: 'swiss-shortcut-',
        })
        const inputPath = `${directory}/input.json`
        yield* fs.writeFileString(inputPath, json)
        return yield* exec([
          'run',
          contract.id,
          '-i',
          inputPath,
          '-o',
          '-',
          '--output-type',
          'public.plain-text',
        ])
      }),
    ).pipe(
      Effect.mapError((cause) => failed(-1, '', cause.message)),
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
      if (!(yield* isInstalled(contract.id))) {
        return yield* new ShortcutNotFound({
          shortcut,
          message: `${shortcut} (${contract.id}) is not installed in Shortcuts`,
        })
      }
      return yield* failed(
        result.code,
        result.stderr,
        result.stderr.trim() || 'no stderr',
      )
    }

    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(contract.output),
    )(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new ShortcutOutputInvalid({
            shortcut,
            output: result.stdout.slice(0, OUTPUT_LIMIT),
            message: `${shortcut} output is invalid: ${cause.message}`,
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

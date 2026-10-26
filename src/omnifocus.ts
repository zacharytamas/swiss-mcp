import {
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import {
  type OmniFocusError,
  OmniFocusFailed,
  OmniFocusNotRepeating,
  OmniFocusOccurrenceMoved,
  OmniFocusOutputInvalid,
  OmniFocusRepeatInvalid,
  type OmniFocusScriptError,
  OmniFocusTagAmbiguous,
  OmniFocusTagNotFound,
  OmniFocusTaskNotFound,
  OmniFocusTimedOut,
} from './omnifocus-errors.ts'
import { ScriptFailure } from './omnifocus-schema.ts'

const OUTPUT_LIMIT = 4096

// Hands one OmniJS program to OmniFocus (Omni Automation, which needs OmniFocus Pro) and prints what it returns.
export const JXA =
  "function run(argv) { return Application('OmniFocus').evaluateJavascript(argv[0]) }"

type JsonCodec = Schema.Codec<unknown, unknown, never, never>

const refusals: Record<
  ScriptFailure['error'],
  new (fields: { readonly message: string }) => OmniFocusScriptError
> = {
  OmniFocusTaskNotFound,
  OmniFocusTagNotFound,
  OmniFocusTagAmbiguous,
  OmniFocusRepeatInvalid,
  OmniFocusNotRepeating,
  OmniFocusOccurrenceMoved,
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // Overridable so the whole server can be exercised against a fake osascript on machines without OmniFocus.
  const bin = yield* Config.String('SWISS_OSASCRIPT_BIN').pipe(
    Config.withDefault('/usr/bin/osascript'),
  )
  // OmniFocus handles one Apple Event at a time, so calls queue here rather than pile up there.
  const lock = yield* Semaphore.make(1)

  const exec = (source: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(bin, ['-l', 'JavaScript', '-e', JXA, source], {
            stdin: 'ignore',
          }),
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

  const evaluate = Effect.fn('OmniFocus.evaluate')(function* <
    O extends JsonCodec,
  >(
    operation: string,
    source: string,
    output: O,
    timeout: Duration.Input = '30 seconds',
  ): Effect.fn.Return<O['Type'], OmniFocusError> {
    const failed = (exitCode: number, stderr: string, detail: string) =>
      new OmniFocusFailed({
        exitCode,
        stderr,
        message: `OmniFocus ${operation} failed (exit ${exitCode}): ${detail}`,
      })
    const timeoutMs = Duration.toMillis(Duration.fromInputUnsafe(timeout))

    const result = yield* lock.withPermit(
      exec(source).pipe(
        Effect.mapError((cause) => failed(-1, '', cause.message)),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(
              new OmniFocusTimedOut({
                timeoutMs,
                message: `OmniFocus ${operation} timed out after ${timeoutMs} ms. It may still have run, so do not retry blindly. A pending macOS Automation permission prompt or an open dialog in OmniFocus is the usual cause.`,
              }),
            ),
        }),
      ),
    )

    if (result.code !== 0) {
      const stderr = result.stderr.trim()
      return yield* failed(
        result.code,
        result.stderr,
        stderr.includes('-1743')
          ? `${stderr} Allow it to control OmniFocus in System Settings > Privacy & Security > Automation.`
          : stderr || 'no stderr',
      )
    }

    const invalid = (cause: { readonly message: string }) =>
      new OmniFocusOutputInvalid({
        output: result.stdout.slice(0, OUTPUT_LIMIT),
        message: `OmniFocus ${operation} ran, but its output is invalid, so any changes it made have already happened: ${cause.message}`,
      })
    const json = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Unknown),
    )(result.stdout).pipe(Effect.mapError(invalid))
    const refusal = Schema.decodeUnknownOption(ScriptFailure)(json)
    if (Option.isSome(refusal)) {
      return yield* new refusals[refusal.value.error]({
        message: refusal.value.message,
      })
    }
    return yield* Schema.decodeUnknownEffect(output)(json).pipe(
      Effect.mapError(invalid),
    )
  })

  return OmniFocus.of({ evaluate })
})

export class OmniFocus extends Context.Service<
  OmniFocus,
  {
    // Runs an OmniJS program (see omnifocus-scripts.ts) and decodes the JSON it returns with `output`.
    readonly evaluate: <O extends JsonCodec>(
      operation: string,
      source: string,
      output: O,
      timeout?: Duration.Input,
    ) => Effect.Effect<O['Type'], OmniFocusError>
  }
>()('swiss-mcp/OmniFocus') {
  static readonly layer = Layer.effect(OmniFocus, make)
}

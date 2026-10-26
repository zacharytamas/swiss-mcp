#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Effect, Layer, Logger } from 'effect'
import { McpProtocol, McpServer, Toolkit } from 'effect/ai'
import pkg from '../package.json' with { type: 'json' }
import { DueToolkit, DueToolkitLive } from './due.ts'
import { Focus } from './focus.ts'
import {
  OmniFocus,
  OmniFocusToolkit,
  OmniFocusToolkitLive,
} from './omnifocus.ts'
import { Shortcuts } from './shortcuts.ts'
import { SlackApi, SlackToolkit, SlackToolkitLive } from './slack.ts'
import { YnabToolkit, YnabToolkitLive } from './ynab.ts'

export const ServerLive = McpServer.toolkit(
  Toolkit.merge(DueToolkit, OmniFocusToolkit, SlackToolkit, YnabToolkit),
).pipe(
  Layer.provide(DueToolkitLive),
  Layer.provide(OmniFocusToolkitLive),
  Layer.provide(SlackToolkitLive),
  Layer.provide(YnabToolkitLive),
  Layer.provide(Shortcuts.layer),
  Layer.provide(OmniFocus.layer),
  Layer.provide(Focus.layer),
  Layer.provide(SlackApi.layer),
  Layer.provideMerge(
    McpServer.layerStdio({
      name: pkg.name,
      version: pkg.version,
      protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18],
    }),
  ),
  Layer.provide(BunServices.layer),
)

// stdout carries JSON-RPC, so every log line goes to stderr. runMain's own failure report runs outside this
// program's context and would log to stdout, so the failure is logged here and runMain's report is turned off.
export const launch = <E>(server: Layer.Layer<never, E>) =>
  BunRuntime.runMain(
    Layer.launch(server).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      Effect.provideService(Logger.LogToStderr, true),
    ),
    { disableErrorReporting: true },
  )

if (import.meta.main) launch(ServerLive)

#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Effect, Layer, Logger } from 'effect'
import { McpProtocol, McpServer } from 'effect/ai'
import pkg from '../package.json' with { type: 'json' }
import { DueToolkit, DueToolkitLive } from './due.ts'
import { Shortcuts } from './shortcuts.ts'

export const ServerLive = McpServer.toolkit(DueToolkit).pipe(
  Layer.provide(DueToolkitLive),
  Layer.provide(Shortcuts.layer),
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

#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Layer } from 'effect'
import { McpProtocol, McpServer } from 'effect/ai'
import pkg from '../package.json' with { type: 'json' }
import { DueToolkit, DueToolkitLive } from './due.ts'
import { Shortcuts } from './shortcuts.ts'

const ServerLive = McpServer.toolkit(DueToolkit).pipe(
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

BunRuntime.runMain(Layer.launch(ServerLive))

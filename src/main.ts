#!/usr/bin/env bun
import { BunRuntime, BunStdio } from "@effect/platform-bun";
import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import pkg from "../package.json" with { type: "json" };

const ServerLive = McpServer.layerStdio({
	name: pkg.name,
	version: pkg.version,
	protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18],
}).pipe(Layer.provide(BunStdio.layer));

BunRuntime.runMain(Layer.launch(ServerLive));

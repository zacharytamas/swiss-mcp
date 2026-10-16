# swiss-mcp

An [MCP](https://modelcontextprotocol.io) server written in TypeScript with [Effect](https://effect.website), run on [Bun](https://bun.sh). It speaks MCP over stdio and runs on macOS, where it drives apps through Apple Shortcuts.

## Tools

| Tool | What it does |
|---|---|
| `due_list_reminders` | List Due reminders with their due dates |
| `due_create_reminder` | Create a one-time reminder (`title`, ISO 8601 `dueDate`) |
| `due_complete_reminder` | Mark reminders with this exact `title` done |
| `due_reschedule_reminder` | Move reminders with this exact `title` to a new `dueDate` |
| `due_list_timers` | List Due timers |
| `due_start_timer` / `due_pause_timer` / `due_stop_timer` | Act on the timer with this exact `name` |

## How it talks to apps

Each app integration is a Shortcuts shortcut generated from code. The server runs it with `/usr/bin/shortcuts run`, passing JSON in a temp file and reading JSON from stdout. Inputs and outputs are Effect Schemas on both sides, and failures come back as tagged errors (`ShortcutNotFound`, `ShortcutFailed`, `ShortcutTimedOut`, `ShortcutInputInvalid`, `ShortcutOutputInvalid`). See `src/shortcuts.ts`.

## Setup

```sh
bun install
bun scripts/build-due-shortcut.ts   # writes and signs dist/swiss-due.shortcut
open dist/swiss-due.shortcut        # click "Add Shortcut"
```

Shortcuts has no way to import a shortcut without that click. The first run may also ask to allow `swiss-due` to use Due; choose **Always Allow**, or background runs stall until the prompt is answered. Re-importing after a rebuild repeats both steps.

Check it end to end:

```sh
bun scripts/verify-due.ts           # read-only: list reminders and timers
bun scripts/verify-due.ts --write   # also creates, reschedules and completes a throwaway reminder
```

## Development

```sh
bun run start   # run the server on stdio
bun run check   # Biome lint/format check + typecheck
bun run fix     # apply Biome fixes
bun test
bun scripts/mcp-call.ts                       # list tools as an MCP client sees them
bun scripts/mcp-call.ts due_list_timers '{}'  # call one tool
```

## Using it from an MCP client

```json
{
  "mcpServers": {
    "swiss-mcp": {
      "command": "bun",
      "args": ["/absolute/path/to/swiss-mcp/src/main.ts"]
    }
  }
}
```

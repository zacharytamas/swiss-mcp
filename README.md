# swiss-mcp

An [MCP](https://modelcontextprotocol.io) server written in TypeScript with [Effect](https://effect.website), run on [Bun](https://bun.sh). It speaks MCP over stdio and runs on macOS, where it drives apps through Apple Shortcuts.

## Tools

| Tool | What it does |
|---|---|
| `due_list_reminders` | List Due reminders with their due dates |
| `due_create_reminder` | Create a one-time reminder (`title`, `dueDate` as local `YYYY-MM-DD HH:mm`) |
| `due_complete_reminder` | Mark reminders with this exact `title` done |
| `due_reschedule_reminder` | Move reminders with this exact `title` to a new `dueDate` |
| `due_start_timer` / `due_pause_timer` / `due_stop_timer` | Act on the timer with this exact `name` |

## How it talks to apps

Each app integration is a Shortcuts shortcut generated from code. The server runs it with `/usr/bin/shortcuts run`, passing JSON in a temp file and reading JSON from stdout. Inputs and outputs are Effect Schemas on both sides, and failures come back as tagged errors (`ShortcutNotFound`, `ShortcutFailed`, `ShortcutTimedOut`, `ShortcutInputInvalid`, `ShortcutOutputInvalid`). See `src/shortcuts.ts`.

## Setup

```sh
bun install
bun scripts/build-due-shortcut.ts                       # writes and signs dist/swiss-due.shortcut
swift scripts/import-shortcut.swift dist/swiss-due.shortcut   # presses "Add Shortcut" (or "Replace")
```

Shortcuts only imports through its "Add Shortcut" window. `import-shortcut.swift` presses the button for you if your terminal has Accessibility permission (System Settings → Privacy & Security → Accessibility); otherwise `open dist/swiss-due.shortcut` and click it. The screen must be unlocked.

Shortcuts asks permission the first time `swiss-due` hands data to each Due action (create, edit, mark done, and so on), and background runs stall until it's answered. Start a run and, while it waits, `swift scripts/allow-shortcut.swift swiss-due` presses Always Allow for that one shortcut. A rebuilt shortcut that imports as a new shortcut asks again.

Check it end to end:

```sh
bun scripts/verify-due.ts           # read-only: list reminders
bun scripts/verify-due.ts --write   # also creates, reschedules and completes a throwaway reminder
```

Known limits, measured on Due 26.4.4: dates are this Mac's local wall-clock time, to the minute, because that is what Due stores; reminders whose title has no letter, digit or space aren't listed; there's no way to list timers; an unknown timer name times out after 10 seconds.

## Development

```sh
bun run start   # run the server on stdio
bun run check   # Biome lint/format check + typecheck
bun run fix     # apply Biome fixes
bun test
bun scripts/mcp-call.ts                       # list tools as an MCP client sees them
bun scripts/mcp-call.ts due_list_reminders '{}'  # call one tool
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

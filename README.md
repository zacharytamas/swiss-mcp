# swiss-mcp

An [MCP](https://modelcontextprotocol.io) server written in TypeScript with [Effect](https://effect.website), run on [Bun](https://bun.sh). It speaks MCP over stdio. On macOS it drives apps through Apple Shortcuts, and it reads Slack through the Slack Web API with your user token.

## Tools

| Tool | What it does |
|---|---|
| `due_list_reminders` | List Due reminders with their due dates |
| `due_create_reminder` | Create a one-time reminder (`title`, `dueDate` as local `YYYY-MM-DD HH:mm`) |
| `due_complete_reminder` | Mark reminders with this exact `title` done |
| `due_reschedule_reminder` | Move reminders with this exact `title` to a new `dueDate` |
| `due_start_timer` / `due_pause_timer` / `due_stop_timer` | Act on the timer with this exact `name` |
| `slack_search_messages` | Search messages with Slack search syntax; IDs in results are resolved to names |
| `slack_read_thread` | A thread's parent and replies, by permalink or `channel` + `ts` |
| `slack_read_channel` | Top-level channel or DM messages, e.g. what led up to a permalink |
| `slack_resolve` | Name and basic info for user, conversation and user-group IDs |
| `slack_my_activity` | What you said since a day, grouped by thread or channel with what you replied to |
| `slack_unanswered_mentions` | Mentions of you, your user groups or your name with no later reply or reaction from you |
| `slack_draft_to_self` | Posts a draft to your own DM, naming where it should go |

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

## Slack

Create a Slack app in your workspace, add these **User Token Scopes**, install it, and put its User OAuth Token (`xoxp-…`) in `SLACK_USER_TOKEN`: `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`, `search:read`, `chat:write`, and `usergroups:read` (without it, mentions of your user groups aren't checked and the tool says so in `notes`). The server never posts anywhere but your own DM.

Slack's composer drafts (`drafts.*`) are an internal API that rejects user tokens with `not_allowed_token_type`, so `slack_draft_to_self` puts the draft in your self-DM, headed with where it should go. `@here` and `@channel` don't count as mentions. Search results follow the search filters in your Slack preferences.

```sh
bun --env-file=.env scripts/verify-slack.ts   # read-only: calls every Slack read tool against your workspace
```

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

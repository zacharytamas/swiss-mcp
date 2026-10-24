# swiss-mcp

An [MCP](https://modelcontextprotocol.io) server written in TypeScript with [Effect](https://effect.website), run on [Bun](https://bun.sh). It speaks MCP over stdio. Its tools fall into three groups. **Due** drives the Due app on macOS through Apple Shortcuts. **Slack** reads Slack and manages your reactions through the Slack Web API with your user token. **YNAB** computes budget numbers from the YNAB API.

```sh
bun install
```

Then set up whichever groups you want to use.

## Due

| Tool                                                     | What it does                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `due_list_reminders`                                     | List Due reminders with their due dates                                     |
| `due_create_reminder`                                    | Create a one-time reminder (`title`, `dueDate` as local `YYYY-MM-DD HH:mm`) |
| `due_complete_reminder`                                  | Mark reminders with this exact `title` done                                 |
| `due_reschedule_reminder`                                | Move reminders with this exact `title` to a new `dueDate`                   |
| `due_start_timer` / `due_pause_timer` / `due_stop_timer` | Act on the timer with this exact `name`                                     |

### How it works

The Due integration is a Shortcuts shortcut generated from code. The server runs it with `/usr/bin/shortcuts run`, passing JSON in a temp file and reading JSON from stdout. Inputs and outputs are Effect Schemas on both sides, and failures come back as tagged errors (`ShortcutNotFound`, `ShortcutFailed`, `ShortcutTimedOut`, `ShortcutInputInvalid`, `ShortcutOutputInvalid`). See `src/shortcuts.ts`.

### Setup

```sh
bun scripts/build-due-shortcut.ts                             # writes and signs dist/swiss-due.shortcut
swift scripts/import-shortcut.swift dist/swiss-due.shortcut   # presses "Add Shortcut" (or "Replace")
```

Shortcuts only imports through its "Add Shortcut" window. `import-shortcut.swift` presses the button for you if your terminal has Accessibility permission (System Settings → Privacy & Security → Accessibility); otherwise `open dist/swiss-due.shortcut` and click it. The screen must be unlocked.

Shortcuts asks permission the first time `swiss-due` hands data to each Due action (create, edit, mark done, and so on), and background runs stall until it's answered. Start a run and, while it waits, `swift scripts/allow-shortcut.swift swiss-due` presses Always Allow for that one shortcut. A rebuilt shortcut that imports as a new shortcut asks again.

### Verify

```sh
bun scripts/verify-due.ts           # read-only: list reminders
bun scripts/verify-due.ts --write   # also creates, reschedules and completes a throwaway reminder
```

### Known limits

Measured on Due 26.4.4:

- Dates are this Mac's local wall-clock time, to the minute, because that is what Due stores.
- Reminders whose title has no letter, digit or space aren't listed.
- There's no way to list timers.
- An unknown timer name times out after 10 seconds.

## Slack

| Tool                                           | What it does                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `slack_search_messages`                        | Search messages with Slack search syntax; IDs in results are resolved to names          |
| `slack_read_thread`                            | A thread's parent and replies, by permalink or `channel` + `ts`                         |
| `slack_read_channel`                           | Top-level channel or DM messages, e.g. what led up to a permalink                       |
| `slack_resolve`                                | Name and basic info for user, conversation and user-group IDs                           |
| `slack_my_activity`                            | What you said since a day, grouped by thread or channel with what you replied to        |
| `slack_unanswered_mentions`                    | Mentions of you, your user groups or your name with no later reply or reaction from you |
| `slack_draft_to_self`                          | Posts a draft to your own DM, naming where it should go                                 |
| `slack_get_reactions`                          | Reactions on one message, with who left each                                            |
| `slack_list_my_reactions`                      | Messages you reacted to, most recent first                                              |
| `slack_add_reaction` / `slack_remove_reaction` | Add or remove your emoji reaction on a message; a repeat is a no-op                     |

### Setup

Create a Slack app in your workspace, add these **User Token Scopes**, install it, and put its User OAuth Token (`xoxp-…`) in `SLACK_USER_TOKEN`:

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`, `search:read`, `chat:write`
- `reactions:read`, `reactions:write`
- `usergroups:read` (without it, mentions of your user groups aren't checked and the tool says so in `notes`)
- `users:read.email` (without it, `slack_resolve` leaves out email addresses)

The server never posts messages anywhere but your own DM. Reactions go on whatever message you point it at.

### Verify

```sh
bun --env-file=.env scripts/verify-slack.ts   # read-only: calls every Slack read tool against your workspace
```

### Known limits

- Slack's composer drafts (`drafts.*`) are an internal API that rejects user tokens with `not_allowed_token_type`, so `slack_draft_to_self` puts the draft in your self-DM, headed with where it should go.
- `@here` and `@channel` don't count as mentions.
- Search results follow the search filters in your Slack preferences.

## YNAB

Small calculations over your YNAB budget, done in code so an agent gets the same answer every time. For everything else, use YNAB's own MCP server.

| Tool              | What it does                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ynab_daily_pace` | Ready to Assign divided by the days until the next pace day: `dailyPace`, `days`, `targetDate`, `readyToAssign`, `budgetId` |

### Setup

- `YNAB_ACCESS_TOKEN` (required). A personal access token from YNAB under Account Settings, then Developer Settings.
- `YNAB_BUDGET_ID` (required). The UUID in the YNAB web app URL.
- `YNAB_PACE_DAY` (optional, default `15`). The day of the month to pace to. The target is always after today, so on the 15th it is next month's 15th. A day past a month's end (such as 31) means that month's last day.

### Known limits

- Today is the server's local date.
- Amounts are in whole currency, such as dollars, not YNAB's milliunits: `12.34` means $12.34. `dailyPace` is rounded down to 0.01, which assumes a currency with two decimal places.

## Development

```sh
bun run start   # run the server on stdio
bun run check   # Biome lint/format check + typecheck
bun run fix     # apply Biome fixes
bun test
bun scripts/mcp-call.ts                          # list tools as an MCP client sees them
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

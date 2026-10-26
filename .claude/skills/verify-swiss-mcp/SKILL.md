---
name: verify-swiss-mcp
description: Drive the swiss-mcp stdio MCP server the way an MCP client does (initialize, tools/list, tools/call) and prove Due and Slack tool behavior against the real Due app and the user's real Slack workspace. Use when verifying a change to src/due.ts, src/slack.ts, src/shortcuts.ts or src/main.ts end to end, or before opening a PR that touches a tool. Not the automated test suite; see "Not the test suite".
---

# Verify swiss-mcp

The user-facing surface is MCP over stdio. A client spawns `bun src/main.ts`, sends `initialize`, then `tools/list` and `tools/call`. There is no UI and no port. Every call in this skill starts its own server process and kills it when the reply arrives.

This skill hits real systems on purpose. That is the point: it proves what the fakes in `bun test` cannot.

- **Due.** The `swiss-due` Apple Shortcut drives the Due app on this Mac. It acts on the user's real reminders and timers.
- **Slack.** `SLACK_USER_TOKEN` in `.env` acts as the user in their real workspace.

## Not the test suite

`bun test` never touches Due or Slack. It runs the real `src/main.ts` over stdio against fakes at the process boundary, not against Effect test layers:

- `src/slack.test.ts` starts a fake Slack Web API with `Bun.serve` and points the server at it with `SWISS_SLACK_API_URL`. It strips every `SLACK_*` variable so the real token never reaches the server under test.
- `src/due.test.ts` points the server at a fake `shortcuts` CLI with `SWISS_SHORTCUTS_BIN`.

Write a regression test there, in that style, for any behavior you fix. Use this skill for what the fakes cannot prove: Slack's and Due's real responses, scopes, permission prompts and rendering of real content.

## Every recipe starts here

Run from the repo root, in one bash shell, and keep the shell for the whole run:

```sh
cd "$(git rev-parse --show-toplevel)"
export VERIFY_RUN="verify-$(uuidgen | tr 'A-Z' 'a-z' | cut -c1-8)"
K=.claude/skills/verify-swiss-mcp; C=$K/call.sh; X=$K/check.sh
$K/doctor.sh
```

Use one `VERIFY_RUN` per run. Never reuse one, and never run two calls at once under the same run and feature.

## Launch

`bun install` once per checkout. Nothing else. Each call spawns the server itself. Ready means the doctor lines for the group you drive are PASS.

Due also needs the `swiss-due` shortcut imported once per Mac. That is a manual, GUI-gated step (README "Due > Setup"). If doctor reports it missing, report the Due features unreachable. Do not import it unasked.

## Doctor

`$K/doctor.sh` is read-only. It prints `INFO build <sha>` with ` +uncommitted` when `git status --porcelain` is non-empty. Then it prints one PASS or FAIL per check. Read the lines, not the exit status:

| FAIL line                              | Blocks              |
| -------------------------------------- | ------------------- |
| `jq 1.6+ missing`                      | every feature       |
| `deps missing`                         | every feature       |
| `server tools/list: expected 26 tools` | every feature       |
| `swiss-due shortcut missing`           | Due features only   |
| `SLACK_USER_TOKEN missing`             | Slack features only |

The token check proves the variable is set, not that it authenticates. A bad token shows up on the first Slack call as `isError` with `SlackApiError:invalid_auth`.

## Drive

```sh
R=$($C <feature-id> <tool> '<json-args>')
```

`call.sh` runs `bun --env-file=.env scripts/mcp-call.ts <tool> <json-args>`. That script spawns the server, initializes, sends one `tools/call` and kills the server. On stdout `call.sh` prints only the saved response file's path, so `R` holds it. On stderr it prints one summary line:

| Summary                           | Meaning                                                                                                                                                                                                                          | Exit |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `ok {…}`                          | `result.structuredContent`, cut to 600 characters                                                                                                                                                                                | 0    |
| `isError {"error":…,"message":…}` | Tool failure. There is no `structuredContent`; the JSON is in `result.content[0].text`. `error` is a tag such as `SlackInputInvalid`, `SlackApiError:channel_not_found` or `ShortcutTimedOut`.                                   | 0    |
| `rpc-error {"code":-32602,…}`     | The arguments failed the tool's Schema. The server rejected them before any Due or Slack call.                                                                                                                                   | 0    |
| `transport-failure …`             | No usable reply. `mcp-call.ts` exits 1 when the server writes a non-JSON line or closes stdout, 2 when the arguments are not JSON (no server starts), and 124 after 300 s with no reply. Read the `.stderr.txt`. The step fails. | 1    |

Build JSON arguments with `jq -cn --arg`, never by pasting variables into a JSON string. Names can contain quotes.

Exit 0 is not a pass. A step passes only when its check passes:

```sh
$X <label> "$R" '<jq filter>' [--arg name value ...]
```

`check.sh` prints `PASS <label>` or `FAIL <label>` and appends that line to `checks.txt` in the feature's evidence directory. The filter can use these definitions:

| Definition    | True when                                   |
| ------------- | ------------------------------------------- |
| `ok`          | The call succeeded with `structuredContent` |
| `sc`          | Shorthand for `.result.structuredContent`   |
| `err("Tag")`  | The call is `isError` with that `error` tag |
| `errmsg`      | The `message` of an `isError`               |
| `rpc(-32602)` | The call is a JSON-RPC error with that code |

Read a value for a later step from the response file. Use `jq -er` so a missing value fails loudly:

```sh
P=$(jq -er '.result.structuredContent.messages[0].permalink' "$R")
```

If a check prints FAIL or an extraction fails, stop that feature, run its Cleanup block, and report the FAIL line.

List the tools as a client sees them: `bun scripts/mcp-call.ts | jq '.result.tools[].name'`.

The recipes are in [features/README.md](features/README.md).

## Evidence

Everything lands in `.audit/verify/$VERIFY_RUN/` (gitignored):

- `build.txt` records the commit plus a content hash when the tree is dirty, followed by `git status --porcelain`. It is written by the run's first call.
- `<feature-id>/NN-<tool>.request.json` holds the tool, the arguments and that build ID.
- `<feature-id>/NN-<tool>.response.json` holds the full JSON-RPC reply. `.stderr.txt` holds server stderr, and `.exit` holds the `mcp-call.ts` exit code.
- `<feature-id>/checks.txt` holds every PASS and FAIL line in order.

A feature is verified when `checks.txt` contains every check label its recipe lists, all PASS. Report anything less as not verified, with the missing or failing labels.

Proof standards:

- Go through `tools/call` on the real server. Calling `src/*.ts` functions directly proves nothing about what a client sees.
- Prove each write with a later read-only call that shows the end state.
- Prove each rejection by its exact form: `rpc(-32602)` for Schema failures, `err("Tag")` for tool failures. A rejected input must never come back `ok`.
- Response files contain real Slack message text. Quote counts, IDs and check lines in reports, never message text.

## Concurrency

| Feature                       | Two runs at once                                                         |
| ----------------------------- | ------------------------------------------------------------------------ |
| Due reminders                 | Safe. Titles carry `$VERIFY_RUN`.                                        |
| Due timers                    | Never. They act on one shared, user-named timer.                         |
| Slack reading, Slack catch-up | Safe. Read-only.                                                         |
| Slack reactions               | Never, in the same workspace. Both runs would race on the same reaction. |
| Slack drafts                  | Safe. Each run posts its own messages.                                   |

## Cleanup

`mcp-call.ts` kills its server on every exit path: a reply, a bad reply, the 300 s deadline, and SIGINT or SIGTERM. It never starts one for arguments that are not JSON. `scripts/mcp-call.test.ts` proves each failure path against a fake server. Bun does not kill a child when its parent dies, so a `kill -9` of `mcp-call.ts` would still orphan the server. Never `pkill bun`. If a server survives, kill only that PID. `pgrep -fl 'bun src/main.ts'` also lists servers the user's own MCP clients started (their working directory is not this repo), so kill only a PID whose start you saw.

Writes are undone through the tools. Each recipe's Cleanup block does this:

- Due reminders: every reminder titled with `$VERIFY_RUN` is completed.
- Slack reactions: the `test_tube` reaction this run added is removed.
- Due timers cannot be restored to their earlier state. The recipe requires a timer that starts stopped, and it ends stopped.
- Slack drafts cannot be deleted by any tool. The recipe says so up front, and the run must tell the user which self-DM messages it left.

Never delete `.audit/verify/`. It is the evidence.

## Helpers

All three are executable. Call them from the repo root as `$K/<name>` once the setup block above has run.

- `doctor.sh` runs the read-only checks under Doctor.
- `call.sh <feature-id> <tool> [json-args]` runs one call and records it. It needs `VERIFY_RUN` and prints the response path.
- `check.sh <label> <response-file> <jq-filter> [jq options]` runs one assertion and records it.

The repo's own whole-group scripts run separately from these recipes and never replace a check:

- `bun scripts/verify-due.ts [--write] [--timer <name>]` runs the Due journeys and exits non-zero on any failed check.
- `bun --env-file=.env scripts/verify-slack.ts` calls the Slack read tools, reaction reads included, and exits non-zero on a tool error or a failed shape check. It prints counts of raw `<@U…>` markup but does not fail on them. It covers no writes.

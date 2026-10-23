# swiss-mcp verification map

This directory is the maintained source for verifying what an MCP client sees from swiss-mcp. Read [../SKILL.md](../SKILL.md) first. It defines `$K`, `$C`, `$X`, `VERIFY_RUN` and the `ok`, `sc`, `err`, `errmsg` and `rpc` check definitions.

## Baseline preconditions

- The setup block from SKILL.md "Every recipe starts here" has run in the current shell.
- The doctor lines for the feature's group are PASS (SKILL.md "Doctor" table).
- The Concurrency table in SKILL.md allows this feature to run now.

## Driving conventions

- Run each feature's blocks in order, in the same shell. Later blocks use variables that earlier blocks set.
- Every call goes through `$C`. Every pass condition goes through `$X`.
- Build JSON arguments with `jq -cn --arg`.
- Name everything this run creates after `$VERIFY_RUN`. Touch only what this run created, or the message of the user's own that the recipe selects.
- If a check prints FAIL or an extraction exits non-zero, stop, run that feature's Cleanup block, and report.

## Proof and skip reporting

- A feature is verified when its `checks.txt` holds every label listed under its `Checks:` line, all PASS.
- An unexercised sub-feature is reported as unexercised, with the reason its recipe gives. It is never counted as verified through another path.
- An unreachable feature is reported with the failing doctor line or the failing call's summary line.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing what an MCP client sees. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists the tools a client calls.
3. `Driving it with call.sh` starts with `Preconditions:` and a `Checks:` line naming every check label. Then come labeled bullets, each with a fenced bash block whose `$X` lines are the pass conditions. A `Cleanup` bullet comes last.
4. `Gotchas` lists traps that can waste or invalidate a run.

## Features

- [Due reminders](./due-reminders.md) covers listing, creating, rescheduling and completing reminders, and date rejection.
- [Due timers](./due-timers.md) covers starting, pausing and stopping a named timer, and the unknown-name timeout.
- [Slack reading](./slack-reading.md) covers search, threads, channel history and ID resolution.
- [Slack catch-up](./slack-catch-up.md) covers your own activity and unanswered mentions.
- [Slack reactions](./slack-reactions.md) covers reading, listing, adding and removing your reactions.
- [Slack drafts](./slack-drafts.md) covers posting a labeled draft to your own DM for a channel, a person or a thread.

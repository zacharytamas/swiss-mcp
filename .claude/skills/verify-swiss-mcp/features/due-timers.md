# Due timers

A client starts, pauses and stops a Due timer by its exact name. The reply only echoes the name, and no tool lists timers or reports their state. Only the Due app shows the effect.

## Sub-features

- `timer-unknown` fails with `ShortcutTimedOut` after 10 seconds for a name Due does not have, and changes nothing.
- `timer-start` starts the named timer.
- `timer-pause` pauses it.
- `timer-stop` stops it.

## How to get to it (user POV)

- `due_start_timer`, `due_pause_timer` and `due_stop_timer`, each with `name`.

## Driving it with call.sh

Preconditions:

- Doctor prints `PASS swiss-due shortcut installed`.
- No other run is driving timers (SKILL.md "Concurrency").
- `timer-start`, `timer-pause` and `timer-stop` also need two things from the user. First, the exact name of a timer that is currently stopped and that they agree may be started and stopped. Second, someone watching the Due app to confirm each state, because no tool can read it. Without both, run only **Unknown**, and report the other three as unexercised with the reason "no user-approved stopped timer and observer".

Checks: `unknown`, plus `start`, `start-seen`, `pause`, `pause-seen`, `stop` and `stop-seen` when the user-approved timer is available.

- **Unknown.** The name contains the run ID, so it cannot match an existing timer unless the user created one with it. The tool description says nothing changes.

  ```sh
  F=due-timers
  R=$($C $F due_start_timer "$(jq -cn --arg n "verify-swiss-mcp $VERIFY_RUN no such timer" '{name:$n}')")
  $X unknown "$R" 'err("ShortcutTimedOut") and (errmsg | contains("timed out after 10000 ms"))'
  ```

- **Name.** Write the user's exact timer name to a file, then read it back. That way quotes or `$` in the name never pass through the shell. An agent writes the file with its file-writing tool; a person types it in an editor.

  ```sh
  NF=.audit/verify/$VERIFY_RUN/$F/timer-name.txt    # one line: the exact name, nothing else
  N=$(cat "$NF")
  ```

- **Start, pause, stop.** Do this block once per row, in order: `start running`, `pause paused`, `stop stopped`. Set `S` and `STATE` from the row. Then ask the observer whether Due shows the timer named `$N` as `$STATE`, and set `SEEN` to `y` or `n` from their answer. Never guess the answer. Stop at the first FAIL and go to Cleanup.

  ```sh
  S=start; STATE=running    # then: S=pause; STATE=paused   then: S=stop; STATE=stopped
  R=$($C $F due_${S}_timer "$(jq -cn --arg n "$N" '{name:$n}')")
  $X $S "$R" 'ok and sc.timers == [{name: $n}]' --arg n "$N"
  screencapture -x ".audit/verify/$VERIFY_RUN/$F/$S.png"
  ```

  After the observer answers:

  ```sh
  SEEN=y    # or n, exactly as the observer answered
  [ "$SEEN" = y ] && v=PASS || v=FAIL
  echo "$v $S-seen (observer saw $STATE: $SEEN)" | tee -a ".audit/verify/$VERIFY_RUN/$F/checks.txt"
  ```

- **Cleanup.** If the run stopped after **start** or **pause**, stop the timer so it ends stopped, the way it began.

  ```sh
  [ -n "${N:-}" ] && $C $F due_stop_timer "$(jq -cn --arg n "$N" '{name:$n}')" >/dev/null
  ```

## Gotchas

- `screencapture -x` captures the whole screen. It is evidence only if Due's window shows the timer. The observer's answer is the check.
- A `ShortcutTimedOut` on a real timer may mean the action ran anyway. Never retry a timed-out start. Ask the observer instead.
- The `-seen` checks are human judgments. Report them as observed by the user, not as tool output.

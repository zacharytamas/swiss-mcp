# Due reminders

A client lists the user's Due reminders with due dates, creates a one-time reminder at a local date and time, moves it, and marks it done. Titles match exactly. Dates go in as this Mac's wall-clock `YYYY-MM-DD HH:mm` and come back as ISO 8601 with the offset in effect on that date.

## Sub-features

- `reminders-create` creates one reminder and returns it with its `dueDate`.
- `reminders-list` lists it with the same date. Titles made only of emoji, CJK or punctuation are left out of every listing.
- `reminders-reschedule` moves reminders with an exact title to a new date.
- `reminders-complete` marks reminders with an exact title done, so they leave the list.
- `reminders-no-match` returns an empty list for a title that matches nothing.
- `reminders-bad-date` rejects a date that does not exist before Due is touched.

## How to get to it (user POV)

- `due_list_reminders` with `{}`.
- `due_create_reminder` with `title` and `dueDate`.
- `due_reschedule_reminder` with `title` and `dueDate`.
- `due_complete_reminder` with `title`.

## Driving it with call.sh

Preconditions:

- Doctor prints `PASS swiss-due shortcut installed`.
- The screen is unlocked, and Due's per-action permission prompts have been answered "Always Allow" (README "Due > Setup"). Otherwise the first write returns `isError` `ShortcutTimedOut`.

Checks: `create`, `listed`, `reschedule`, `moved`, `bad-date`, `bad-date-absent`, `complete`, `gone`, `no-match`.

- **Setup.** `A` and `B` are one and two hours from now. `date -v` is the BSD `date` that macOS ships.

  ```sh
  F=due-reminders; T="verify-swiss-mcp $VERIFY_RUN"
  A=$(date -v+60M '+%Y-%m-%d %H:%M'); B=$(date -v+120M '+%Y-%m-%d %H:%M')
  ```

- **Create.**

  ```sh
  R=$($C $F due_create_reminder "$(jq -cn --arg t "$T" --arg d "$A" '{title:$t,dueDate:$d}')")
  $X create "$R" 'ok and (sc.reminders | length == 1 and .[0].title == $t and .[0].dueDate[0:16] == $d)' --arg t "$T" --arg d "${A/ /T}"
  ```

- **Listed.**

  ```sh
  R=$($C $F due_list_reminders '{}')
  $X listed "$R" 'ok and ([sc.reminders[] | select(.title == $t)] | length == 1 and .[0].dueDate[0:16] == $d)' --arg t "$T" --arg d "${A/ /T}"
  ```

- **Reschedule.** The reply names the matched reminders and carries no `dueDate`.

  ```sh
  R=$($C $F due_reschedule_reminder "$(jq -cn --arg t "$T" --arg d "$B" '{title:$t,dueDate:$d}')")
  $X reschedule "$R" 'ok and sc.reminders == [{title: $t}]' --arg t "$T"
  ```

- **Moved.**

  ```sh
  R=$($C $F due_list_reminders '{}')
  $X moved "$R" 'ok and ([sc.reminders[] | select(.title == $t)] | length == 1 and .[0].dueDate[0:16] == $d)' --arg t "$T" --arg d "${B/ /T}"
  ```

- **Bad date.** February 30 does not exist.

  ```sh
  R=$($C $F due_create_reminder "$(jq -cn --arg t "$T bad-date" '{title:$t,dueDate:"2026-02-30 09:00"}')")
  $X bad-date "$R" 'rpc(-32602) and (.error.message | contains("2026-02-30 09:00 does not exist"))'
  R=$($C $F due_list_reminders '{}')
  $X bad-date-absent "$R" 'ok and all(sc.reminders[]; .title != $t)' --arg t "$T bad-date"
  ```

- **Complete.**

  ```sh
  R=$($C $F due_complete_reminder "$(jq -cn --arg t "$T" '{title:$t}')")
  $X complete "$R" 'ok and sc.reminders == [{title: $t}]' --arg t "$T"
  ```

- **Gone.**

  ```sh
  R=$($C $F due_list_reminders '{}')
  $X gone "$R" 'ok and all(sc.reminders[]; .title != $t)' --arg t "$T"
  ```

- **No match.**

  ```sh
  R=$($C $F due_complete_reminder "$(jq -cn --arg t "$T (no such reminder)" '{title:$t}')")
  $X no-match "$R" 'ok and sc.reminders == []'
  ```

- **Cleanup.** Completes anything titled with this run's ID that is still listed. It always runs, and it is a no-op after a passing run.

  ```sh
  R=$($C $F due_list_reminders '{}')
  jq -r --arg r "$VERIFY_RUN" '.result.structuredContent.reminders[]?.title | select(contains($r))' "$R" |
    while IFS= read -r t; do $C $F due_complete_reminder "$(jq -cn --arg t "$t" '{title:$t}')" >/dev/null; done
  ```

## Gotchas

- Reschedule and complete act on every reminder with that exact title. Never drive them with a title that lacks `$VERIFY_RUN`.
- Compare `dueDate[0:16]` against the local time with `T` in place of the space. The offset is whatever applies on that date.
- Each call takes about 1 s. A call that takes 30 s and returns `ShortcutTimedOut` usually means a pending macOS permission prompt. It may still have run, so check the list before retrying.

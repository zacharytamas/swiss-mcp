# Slack catch-up

A client asks what the user said on Slack since a day, grouped by thread or channel along with what each message answered. It also asks which mentions of the user still have no later reply or reaction from them.

## Sub-features

- `catch-up-activity` returns one conversation per thread or channel the user posted in. Each one contains a `fromMe` message and a Boolean `complete`.
- `catch-up-incomplete` marks a conversation `complete: false` when messages past the 200-message read cap were left out.
- `catch-up-mentions` returns unanswered mentions. None is the user's own message, and each has `via` drawn from `direct`, `group` and `name`.
- `catch-up-notes` explains in `notes` what was skipped, for example user-group mentions without the `usergroups:read` scope.
- `catch-up-bad-day` rejects a `since` that is not `YYYY-MM-DD`.

## How to get to it (user POV)

- `slack_my_activity` with `since`, optional `limit` (default 50) and `context` (default 5).
- `slack_unanswered_mentions` with `since`, optional `minAgeHours` (default 2), `names` and `limit` (default 50).

## Driving it with call.sh

Preconditions:

- Doctor prints `PASS SLACK_USER_TOKEN set`.
- The user posted in Slack during the last 7 days. Otherwise **activity** fails and the feature is unreachable.

Checks: `activity`, `mentions`, `bad-day`.

- **Activity.**

  ```sh
  F=slack-catch-up; D=$(date -v-7d +%Y-%m-%d)
  R=$($C $F slack_my_activity "$(jq -cn --arg d "$D" '{since:$d,limit:20}')")
  $X activity "$R" 'ok and (sc.conversations | length >= 1 and all(.[]; (.complete | type == "boolean") and any(.messages[]; .fromMe)))'
  jq '[.result.structuredContent.conversations[] | select(.complete == false)] | length' "$R"
  ```

  The last line prints how many conversations are incomplete. Zero means `catch-up-incomplete` is unexercised. Report it that way. It is not a failure.

- **Mentions.**

  ```sh
  R=$($C $F slack_unanswered_mentions "$(jq -cn --arg d "$D" '{since:$d,limit:20}')")
  $X mentions "$R" 'ok and (sc | has("searchedFor") and has("checked") and has("unanswered") and has("undetermined") and has("notes")) and all(sc.unanswered[]; (.message.fromMe | not) and (.via | length >= 1) and all(.via[]; IN("direct", "group", "name")))'
  jq -c '{unanswered: (.result.structuredContent.unanswered | length), notes: .result.structuredContent.notes}' "$R"
  ```

  Zero `unanswered` passes the check but leaves the positive case unexercised. `catch-up-notes` is exercised only when `notes` is non-empty. Do not change scopes or Slack state to force either case.

- **Bad day.**

  ```sh
  R=$($C $F slack_my_activity '{"since":"yesterday"}')
  $X bad-day "$R" 'rpc(-32602) and (.error.message | contains("must be YYYY-MM-DD"))'
  ```

- **Cleanup.** None. Every call is read-only.

## Gotchas

- Both tools fan out into many Slack calls. Several seconds is normal on a busy week. Only `call.sh`'s 300 s deadline counts as a hang.
- Mentions newer than `minAgeHours` are skipped, so a mention made just now will not show up.
- `@here` and `@channel` never count as mentions.
- Whether a particular mention is unanswered depends on live Slack state. Check the invariants above, not an expected list.

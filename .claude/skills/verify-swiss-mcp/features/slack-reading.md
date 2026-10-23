# Slack reading

A client searches Slack with Slack search syntax, opens a thread or the channel history leading up to a message, and turns raw Slack IDs into names. Messages come back with user and channel references resolved to names, and with `fromMe` set on the user's own messages.

## Sub-features

- `read-search` returns matching messages with resolved authors and permalinks.
- `read-thread` returns a thread's parent and replies from a permalink, including the linked message, with every author resolved to a name.
- `read-channel` returns top-level messages in the permalink's channel at or before the permalink's message.
- `read-resolve` resolves user IDs in bare and `<@U…>` form, and lists anything else under `unresolved` with the reason.
- `read-not-found` fails with `SlackApiError:channel_not_found` for a conversation that does not exist.

## How to get to it (user POV)

- `slack_search_messages` with `query`, optional `limit` (default 20) and `sort`.
- `slack_read_thread` with `permalink`, or `channel` and `ts`.
- `slack_read_channel` with `permalink` or `channel`, optional `oldest`, `latest` and `limit` (default 20). A permalink sets `latest` to its message unless `latest` is given.
- `slack_resolve` with `ids`.

## Driving it with call.sh

Preconditions:

- Doctor prints `PASS SLACK_USER_TOKEN set`.
- The user has posted at least one message that `from:@me` finds. Otherwise **search** fails and the feature is unreachable.

Checks: `search`, `thread`, `channel`, `resolve`, `not-found`, `regression`.

- **Search.**

  ```sh
  F=slack-reading
  R=$($C $F slack_search_messages '{"query":"from:@me","limit":3}')
  $X search "$R" 'ok and (sc.messages | length >= 1 and all(.[]; .fromMe and .author.name != .author.id))'
  P=$(jq -er '.result.structuredContent.messages[0].permalink' "$R")
  U=$(jq -er '.result.structuredContent.messages[0].author.id' "$R")
  CH=$(jq -er '.result.structuredContent.messages[0].channel.id' "$R")
  TS=$(jq -er '.result.structuredContent.messages[0].ts' "$R")
  ```

- **Thread.** Markup rendering is not checked here. Literal `<@U…>` text from plain-text blocks is correct output, and `src/slack.test.ts` covers rendering with fixtures.

  ```sh
  R=$($C $F slack_read_thread "$(jq -cn --arg p "$P" '{permalink:$p}')")
  $X thread "$R" 'ok and sc.channel.id == $ch and any(sc.messages[]; .ts == $ts) and all(sc.messages[]; .channel.id == $ch and .author.name != .author.id)' --arg ch "$CH" --arg ts "$TS"
  ```

- **Channel.** Every message is in the same channel and no later than the permalink's message. Equal-length Slack `ts` strings compare correctly as strings.

  ```sh
  R=$($C $F slack_read_channel "$(jq -cn --arg p "$P" '{permalink:$p,limit:5}')")
  $X channel "$R" 'ok and (sc.messages | length >= 1 and length <= 5 and all(.[]; .channel.id == $ch and .ts <= $ts))' --arg ch "$CH" --arg ts "$TS"
  ```

- **Resolve.**

  ```sh
  R=$($C $F slack_resolve "$(jq -cn --arg u "$U" '{ids:[$u, "<@\($u)>", "nonsense"]}')")
  $X resolve "$R" 'ok and (sc.users | length == 2 and all(.[]; .id == $u)) and sc.unresolved == [sc.unresolved[0]] and sc.unresolved[0].id == "nonsense" and (sc.unresolved[0].error | startswith("not a Slack ID:"))' --arg u "$U"
  ```

- **Not found.**

  ```sh
  R=$($C $F slack_read_thread '{"channel":"C000000","ts":"1.2"}')
  $X not-found "$R" 'err("SlackApiError:channel_not_found")'
  ```

- **Regression.** Run after the steps above, never at the same time.

  ```sh
  D=.audit/verify/$VERIFY_RUN/$F
  bun --env-file=.env scripts/verify-slack.ts >"$D/regression.stdout.txt" 2>"$D/regression.stderr.txt"; echo $? >"$D/regression.exit"
  [ "$(cat "$D/regression.exit")" = 0 ] && v=PASS || v=FAIL; echo "$v regression (verify-slack.ts)" | tee -a "$D/checks.txt"
  ```

- **Cleanup.** None. Every call is read-only.

## Gotchas

- Response files hold real message text. Report check lines, counts and IDs, never text. `regression.stdout.txt` holds shapes only and is safe to quote.
- Search follows the search filters in the user's Slack preferences, so results can differ from what Slack's UI shows with other filters.
- Slack indexes new messages for search after a delay. A message posted seconds ago may not be found yet.
- `slack_read_channel` returns top-level messages only. Replies need `slack_read_thread`.

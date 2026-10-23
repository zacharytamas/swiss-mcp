# Slack reactions

A client reads the reactions on a message along with who left each, lists the messages the user reacted to, and adds or removes the user's own emoji reaction. Adding a reaction that is already there, or removing one that is not, succeeds with `changed: false`.

## Sub-features

- `reactions-get` returns the message and its reactions, each with `byMe` and resolved users.
- `reactions-list-mine` returns messages the user reacted to, each with a `byMe` reaction.
- `reactions-add` adds the user's reaction and reports `changed: true`. With or without colons, `name` comes back without them.
- `reactions-add-repeat` reports `changed: false` for a reaction already left.
- `reactions-remove` removes it and reports `changed: true`, then `changed: false` on repeat.
- `reactions-invalid` rejects a name that cannot be an emoji, and a call that names no message.

## How to get to it (user POV)

- `slack_get_reactions` with `permalink`, or `channel` and `ts`.
- `slack_list_my_reactions` with optional `limit` (default 20).
- `slack_add_reaction` and `slack_remove_reaction` with `permalink` (or `channel` and `ts`) and `name`.

## Driving it with call.sh

Preconditions:

- Doctor prints `PASS SLACK_USER_TOKEN set`.
- No other run is writing reactions in this workspace (SKILL.md "Concurrency").

Checks: `pick`, `add`, `add-repeat`, `after-add`, `list-mine`, `remove`, `remove-repeat`, `after-remove`, `invalid-name`, `no-message`.

- **Pick.** Choose the newest of the user's own messages that has no `test_tube` reaction from anyone. Reacting on one's own message keeps the change out of other people's notifications. If none of the 20 qualifies, **pick** fails and the feature is unreachable.

  ```sh
  F=slack-reactions; P=
  R=$($C $F slack_search_messages '{"query":"from:@me","limit":20}')
  ME=$(jq -er '.result.structuredContent.messages[0].author.id' "$R")
  for p in $(jq -r '.result.structuredContent.messages[].permalink' "$R"); do
    G=$($C $F slack_get_reactions "$(jq -cn --arg p "$p" '{permalink:$p}')")
    if jq -e 'all(.result.structuredContent.reactions[]; .name != "test_tube")' "$G" >/dev/null; then P=$p; break; fi
  done
  $X pick "$G" 'ok and all(sc.reactions[]; .name != "test_tube") and $p != ""' --arg p "$P"
  ```

- **Add.** If this does not print PASS, stop. Do not remove anything; the reaction may not be this run's.

  ```sh
  ADDED=
  R=$($C $F slack_add_reaction "$(jq -cn --arg p "$P" '{permalink:$p,name:":test_tube:"}')")
  $X add "$R" 'ok and sc == {name: "test_tube", changed: true}' && ADDED=1
  ```

- **Add again.**

  ```sh
  R=$($C $F slack_add_reaction "$(jq -cn --arg p "$P" '{permalink:$p,name:"test_tube"}')")
  $X add-repeat "$R" 'ok and sc == {name: "test_tube", changed: false}'
  ```

- **After add.**

  ```sh
  R=$($C $F slack_get_reactions "$(jq -cn --arg p "$P" '{permalink:$p}')")
  $X after-add "$R" 'ok and any(sc.reactions[]; .name == "test_tube" and .byMe and any(.users[]; .id == $me))' --arg me "$ME"
  ```

- **Listed.**

  ```sh
  R=$($C $F slack_list_my_reactions '{"limit":5}')
  $X list-mine "$R" 'ok and (sc.messages | length >= 1 and all(.[]; any(.reactions[]; .byMe)))'
  ```

- **Remove.**

  ```sh
  R=$($C $F slack_remove_reaction "$(jq -cn --arg p "$P" '{permalink:$p,name:"test_tube"}')")
  $X remove "$R" 'ok and sc == {name: "test_tube", changed: true}' && ADDED=
  ```

- **Remove again.**

  ```sh
  R=$($C $F slack_remove_reaction "$(jq -cn --arg p "$P" '{permalink:$p,name:"test_tube"}')")
  $X remove-repeat "$R" 'ok and sc == {name: "test_tube", changed: false}'
  ```

- **After remove.** Someone else may have added `test_tube` meanwhile. Only the user's own must be gone.

  ```sh
  R=$($C $F slack_get_reactions "$(jq -cn --arg p "$P" '{permalink:$p}')")
  $X after-remove "$R" 'ok and all(sc.reactions[]; .name != "test_tube" or (.byMe | not))'
  ```

- **Invalid name.** Custom emoji names cannot contain spaces, so this name cannot exist.

  ```sh
  R=$($C $F slack_add_reaction "$(jq -cn --arg p "$P" '{permalink:$p,name:"not an emoji"}')")
  $X invalid-name "$R" 'err("SlackApiError:invalid_name")'
  ```

- **No message.**

  ```sh
  R=$($C $F slack_add_reaction '{"name":"test_tube"}')
  $X no-message "$R" 'err("SlackInputInvalid") and errmsg == "Pass either permalink, or channel (and ts where needed)."'
  ```

- **Cleanup.** Removes the reaction only if this run added it and has not removed it yet.

  ```sh
  [ -n "${ADDED:-}" ] && $C $F slack_remove_reaction "$(jq -cn --arg p "$P" '{permalink:$p,name:"test_tube"}')" >/dev/null
  ```

## Gotchas

- Never remove a reaction this run did not add. `ADDED` is set only by a PASSing **add**.
- Slack does not notify for reactions on your own message, but anyone else in that conversation can see the reaction while it exists.
- `list-mine` shows the user's reactions anywhere, not only this run's.

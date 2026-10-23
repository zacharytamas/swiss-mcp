# Slack drafts

A client hands the user a draft without sending it anywhere else. The server posts a new message in the user's DM with themselves (the self-DM), headed `:memo: Draft for <destination>`, and returns its permalink. The user copies the text to the destination and sends it there.

## Sub-features

- `draft-bad-to` rejects a destination that is not a Slack ID, without posting.
- `draft-thread-to-user` rejects a thread reply addressed to a user ID, without posting.
- `draft-channel` posts a draft addressed to a channel.
- `draft-dm` posts a draft addressed to a person.
- `draft-thread` posts a draft addressed to a thread in a channel.

## How to get to it (user POV)

- `slack_draft_to_self` with `to` (a `C…`/`G…`/`D…` conversation ID or a `U…`/`W…` user ID), `text`, and optional `threadTs`.

## Driving it with call.sh

Preconditions:

- Doctor prints `PASS SLACK_USER_TOKEN set`.
- The two rejection steps are always safe. The three posting steps leave messages in the user's self-DM that no tool can delete. Run them only when the change under test touches drafts or the user asked for them, and tell the user afterwards which ones exist.
- The user has opened their self-DM in Slack at least once. If not, **channel** fails with `isError` `SlackInputInvalid` and the message `Could not find your self-DM; open it once in Slack and try again.` That is a missing precondition, not a format failure. Report the posting steps unreachable and do not retry.
- The user's 20 newest `from:@me` messages include one in a public channel (`channel.kind` `channel`). Otherwise **pick** fails and the channel and thread steps are unreachable.

Checks: `pick`, `bad-to`, `thread-to-user`, plus `channel`, `channel-posted`, `dm`, `dm-posted`, `thread` and `thread-posted` when the posting steps run.

- **Pick.** `TS` is the thread parent: the message's `threadTs` when it is a reply, else its `ts`. `BASE` is the workspace URL that permalinks start with.

  ```sh
  F=slack-drafts
  R=$($C $F slack_search_messages '{"query":"from:@me","limit":20}')
  $X pick "$R" 'ok and any(sc.messages[]; .channel.kind == "channel")'
  U=$(jq -er '.result.structuredContent.messages[0].author.id' "$R")
  ME=$(jq -er '.result.structuredContent.messages[0].author.name' "$R")
  M=$(jq -ce '[.result.structuredContent.messages[] | select(.channel.kind == "channel")][0]' "$R")
  CH=$(jq -er '.channel.id' <<<"$M"); CHN=$(jq -er '.channel.name' <<<"$M"); TS=$(jq -er '.threadTs // .ts' <<<"$M")
  BASE=$(jq -er '.permalink | sub("archives/.*"; "")' <<<"$M")
  ```

- **Bad destination.**

  ```sh
  R=$($C $F slack_draft_to_self '{"to":"general","text":"x"}')
  $X bad-to "$R" 'err("SlackInputInvalid") and errmsg == "to must be a channel ID (C…/G…/D…) or a user ID (U…/W…), got \"general\"."'
  ```

- **Thread to user.**

  ```sh
  R=$($C $F slack_draft_to_self "$(jq -cn --arg u "$U" --arg ts "$TS" '{to:$u,text:"x",threadTs:$ts}')")
  $X thread-to-user "$R" 'err("SlackInputInvalid") and errmsg == "A thread reply needs the conversation it lives in: pass the DM channel ID (D…) as `to`, not the user ID."'
  ```

  Both rejections are raised in `draftToSelf` before it looks up the self-DM or posts. `src/slack.test.ts` proves "without posting" against the fake Slack. Here the check proves the rejection only.

- **Channel draft.**

  ```sh
  R=$($C $F slack_draft_to_self "$(jq -cn --arg to "$CH" --arg t "verify-swiss-mcp $VERIFY_RUN channel" '{to:$to,text:$t}')")
  $X channel "$R" 'ok and (sc.draftPermalink | type == "string")'
  DP=$(jq -er '.result.structuredContent.draftPermalink' "$R")
  R=$($C $F slack_read_thread "$(jq -cn --arg p "$DP" '{permalink:$p}')")
  SELF=$(jq -er '.result.structuredContent.channel.id' "$R")
  printf -v E ':memo: Draft for #%s\n\nverify-swiss-mcp %s channel' "$CHN" "$VERIFY_RUN"
  $X channel-posted "$R" 'ok and sc.channel.kind == "dm" and sc.channel.name == "@\($me)" and (sc.messages | length == 1 and .[0].fromMe and .[0].text == $e)' --arg me "$ME" --arg e "$E"
  ```

- **DM draft.**

  ```sh
  R=$($C $F slack_draft_to_self "$(jq -cn --arg to "$U" --arg t "verify-swiss-mcp $VERIFY_RUN dm" '{to:$to,text:$t}')")
  $X dm "$R" 'ok and (sc.draftPermalink | type == "string")'
  DP=$(jq -er '.result.structuredContent.draftPermalink' "$R")
  R=$($C $F slack_read_thread "$(jq -cn --arg p "$DP" '{permalink:$p}')")
  printf -v E ':memo: Draft for @%s\n\nverify-swiss-mcp %s dm' "$ME" "$VERIFY_RUN"
  $X dm-posted "$R" 'ok and sc.channel.id == $self and (sc.messages | length == 1 and .[0].fromMe and .[0].text == $e)' --arg self "$SELF" --arg e "$E"
  ```

- **Thread draft.**

  ```sh
  R=$($C $F slack_draft_to_self "$(jq -cn --arg to "$CH" --arg ts "$TS" --arg t "verify-swiss-mcp $VERIFY_RUN thread" '{to:$to,text:$t,threadTs:$ts}')")
  $X thread "$R" 'ok and (sc.draftPermalink | type == "string")'
  DP=$(jq -er '.result.structuredContent.draftPermalink' "$R")
  R=$($C $F slack_read_thread "$(jq -cn --arg p "$DP" '{permalink:$p}')")
  printf -v E ':memo: Draft for [this thread](%sarchives/%s/p%s) in #%s\n\nverify-swiss-mcp %s thread' "$BASE" "$CH" "${TS/./}" "$CHN" "$VERIFY_RUN"
  $X thread-posted "$R" 'ok and sc.channel.id == $self and (sc.messages | length == 1 and .[0].fromMe and .[0].text == $e)' --arg self "$SELF" --arg e "$E"
  ```

- **Cleanup.** No tool can delete a post. List what was left for the user:

  ```sh
  jq -r 'select(.result.structuredContent.draftPermalink) | .result.structuredContent.draftPermalink' .audit/verify/$VERIFY_RUN/$F/*-slack_draft_to_self.response.json
  ```

## Gotchas

- Run the rejection steps first. They prove the guards without leaving anything behind.
- Each successful call posts a new message. Repeating a step posts again.
- If a `-posted` check fails, compare `.result.structuredContent.messages[0].text` with `$E` before changing anything. The expected headers come from `draftToSelf` and the read tools' markup rendering in `src/slack.ts`. Fix whichever one is wrong, and never loosen the check.
- Slack's real composer drafts are unreachable with a user token (README "Known limits"). Seeing nothing in Slack's Drafts list is expected.

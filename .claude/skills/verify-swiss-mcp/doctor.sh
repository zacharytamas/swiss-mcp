#!/usr/bin/env bash
set -u
cd "$(git rev-parse --show-toplevel)"
fail=0
say() { printf '%s %s\n' "$1" "$2"; if [ "$1" = FAIL ]; then fail=1; fi; }

dirty=$(test -z "$(git status --porcelain)" || echo ' +uncommitted')
say INFO "build $(git rev-parse --short HEAD)$dirty"

if jq --version 2>/dev/null | grep -q '^jq-1\.[6-9]'; then say PASS "jq $(jq --version)"
else say FAIL 'jq 1.6+ missing: every recipe needs it (brew install jq)'; fi

if [ -d node_modules/effect ]; then say PASS 'deps installed'
else say FAIL 'deps missing: run bun install'; fi

count=$(MCP_CALL_TIMEOUT_MS=60000 bun scripts/mcp-call.ts 2>/dev/null | jq '.result.tools | length' 2>/dev/null)
if [ "${count:-0}" -eq 26 ]; then say PASS 'server answers tools/list with 26 tools'
else say FAIL "server tools/list: expected 26 tools, got ${count:-no reply}"; fi

if shortcuts list | grep -qx swiss-due; then say PASS 'swiss-due shortcut installed'
else say FAIL 'swiss-due shortcut missing: Due features cannot run (README Due setup)'; fi

if bun --env-file=.env -e 'process.exit(process.env.SLACK_USER_TOKEN?.trim() ? 0 : 1)'; then
  say PASS 'SLACK_USER_TOKEN set (auth and scopes not checked)'
else say FAIL 'SLACK_USER_TOKEN missing: Slack features cannot run'; fi

exit $fail

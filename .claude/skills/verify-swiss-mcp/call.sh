#!/usr/bin/env bash
# Usage: call.sh <feature-id> <tool> [json-args]
set -u
[ $# -ge 2 ] || { echo 'usage: call.sh <feature-id> <tool> [json-args]' >&2; exit 2; }
[ -n "${VERIFY_RUN:-}" ] || { echo 'call.sh: export VERIFY_RUN first (see features/README.md)' >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)"
feature=$1 tool=$2 args=${3:-'{}'}
run=.audit/verify/$VERIFY_RUN
dir=$run/$feature
mkdir -p "$dir"

build=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  build="$build+$({ git diff HEAD; git ls-files --others --exclude-standard -z | xargs -0 cat; } | shasum | cut -c1-8)"
fi
[ -f "$run/build.txt" ] || { echo "$build"; git status --porcelain; } >"$run/build.txt"

last=$(find "$dir" -name '*.request.json' | sed -E 's|.*/([0-9]+)-.*|\1|' | sort -n | tail -1)
n=$(printf '%02d' $(( 10#${last:-0} + 1 )))
base=$dir/$n-$tool
jq -cn --arg tool "$tool" --argjson arguments "$args" --arg build "$build" \
  '{tool: $tool, arguments: $arguments, build: $build}' >"$base.request.json" || exit 2
bun --env-file=.env scripts/mcp-call.ts "$tool" "$args" >"$base.response.json" 2>"$base.stderr.txt"
echo $? >"$base.exit"

summary=$(jq -r '
  if .error then "rpc-error \(.error | tojson)"
  elif .result.isError then "isError \(.result.content[0].text)"
  elif .result.structuredContent then "ok \(.result.structuredContent | tojson | .[0:600])"
  else empty end' "$base.response.json" 2>/dev/null)
if [ -z "$summary" ]; then
  echo "transport-failure exit $(cat "$base.exit"), see $base.stderr.txt" >&2
  echo "$base.response.json"
  exit 1
fi
echo "$summary" >&2
echo "$base.response.json"

#!/usr/bin/env bash
# Usage: check.sh <label> <response-file> <jq-filter> [jq options, e.g. --arg t "$T"]
# Passes when the filter is true for the response. Appends PASS/FAIL to checks.txt beside the response.
set -u
[ $# -ge 3 ] || { echo 'usage: check.sh <label> <response-file> <jq-filter> [jq options]' >&2; exit 2; }
label=$1 file=$2 filter=$3
shift 3
prelude='
def sc: .result.structuredContent;
def ok: .error == null and .result.isError == false and sc != null;
def err($tag): .result.isError == true and (.result.content[0].text | fromjson | .error) == $tag;
def errmsg: .result.content[0].text | fromjson | .message;
def rpc($code): .error.code == $code;
'
if jq -e "$@" "$prelude ($filter)" "$file" >/dev/null 2>&1; then verdict=PASS; else verdict=FAIL; fi
echo "$verdict $label ($(basename "$file"))" | tee -a "$(dirname "$file")/checks.txt"
[ $verdict = PASS ]

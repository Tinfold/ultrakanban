#!/usr/bin/env bash
# Tests which limit clear_build_output goes by: bash scripts/agent-loop/build-limit-test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
log() { echo "$*"; }
# shellcheck source=checkout.sh
source <(sed -n '/^clear_build_output() {$/,/^}$/p;/^clear_ignored() /p' "$here/checkout.sh")
cd "$tmp" || exit 1
git init -q .
echo target >.gitignore
fails=0

# du is faked: target/ takes 2 GB.
mkdir "$tmp/bin"
printf '#!/bin/sh\nprintf "%%s\\ttotal\\n" %s\n' $((2 * 1024 * 1024)) >"$tmp/bin/du"
chmod +x "$tmp/bin/du"
PATH=$tmp/bin:$PATH

check() {
  mkdir -p target && : >target/file
  # shellcheck disable=SC2034 # read by clear_build_output
  MAX_BUILD_GB=$3
  eval "board() { printf '%s\n' '$2'; }"
  clear_build_output >/dev/null 2>&1
  local got=kept
  [[ -e target/file ]] || got=cleared
  if [[ $got == "$4" ]]; then echo "ok: $1"; else
    echo "FAIL: $1: got $got, wanted $4"
    fails=$((fails + 1))
  fi
}

check "without a board setting it goes by MAX_BUILD_GB, under" '{"board":{"agentMaxBuildGb":null}}' 5 kept
check "without a board setting it goes by MAX_BUILD_GB, over" '{"board":{"agentMaxBuildGb":null}}' 1 cleared
check "the board's setting wins over a lower MAX_BUILD_GB" '{"board":{"agentMaxBuildGb":5}}' 1 kept
check "the board's setting wins over a higher MAX_BUILD_GB" '{"board":{"agentMaxBuildGb":1}}' 5 cleared
check "0 on the board keeps it all" '{"board":{"agentMaxBuildGb":0}}' 1 kept
check "0 in MAX_BUILD_GB keeps it all" '{"board":{"agentMaxBuildGb":null}}' 0 kept
exit $((fails > 0))

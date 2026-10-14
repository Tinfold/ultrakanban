#!/usr/bin/env bash
# The updater container (docker compose --profile updater, deploy/updater.Dockerfile): updates ultrakanban when someone
# asks for it in the app (the update button in the header) where no agent supervisor on the machine does, because there
# are no systemd user services: Windows and macOS with Docker Desktop, Linux without systemd. It does what the
# supervisor's check_in and update_board do (scripts/agent-supervisor.sh): every POLL_SECONDS it checks in with the
# checkout's version and how many commits it is behind origin (fetched every UPDATE_FETCH_SECONDS), and when an update
# has been asked for it moves the checkout to origin's default branch (keeping its local changes in a stash and commits
# of its own on a backup branch), then rebuilds and restarts the compose project's running containers with the compose
# files they were started with (e.g. deploy/compose.gpu.yml), and reports how it went.
#
# The checkout is mounted at /repo and the Docker socket at /var/run/docker.sock. It runs from the checkout and starts
# again after an update, so it always runs the version it pulled; its own container isn't rebuilt (that would stop it
# mid-update), so run the `up` command yourself when deploy/updater.Dockerfile changes.

set -uo pipefail

KANBAN=${KANBAN:-http://app:4317}
POLL_SECONDS=${POLL_SECONDS:-30}
UPDATE_FETCH_SECONDS=${UPDATE_FETCH_SECONDS:-900}
REPO=${REPO:-/repo}
self=$(readlink -f "$0")

# git in the checkout, as the checkout's owner so the files it pulls aren't root's.
owner=$(stat -c %u:%g "$REPO")
as_owner() { su-exec "$owner" env HOME=/tmp GIT_TERMINAL_PROMPT=0 "$@"; }
git() { as_owner git -C "$REPO" "$@"; }

# Posts to the board's update status (see reportAppUpdateSchema): `report <json>`. Prints the status it answers with.
report() {
  curl -sf -X POST "$KANBAN/api/system/update/status" -H 'Content-Type: application/json' \
    -H 'X-Actor: updater' -d "$1"
}

# The checkout's version and commit, and how far its default branch is behind and ahead of origin, as report fields.
checkout_state() {
  local branch=$1 behind ahead
  behind=$(git rev-list --count "$branch..origin/$branch" 2>/dev/null) || behind=null
  ahead=$(git rev-list --count "origin/$branch..$branch" 2>/dev/null) || ahead=null
  jq -nc --arg version "$(git log -1 --format='%h %s' 2>/dev/null)" --argjson behind "$behind" \
    --argjson ahead "$ahead" --arg commit "$(git rev-parse HEAD 2>/dev/null)" \
    '{version: (if $version == "" then null else $version end), behind: $behind, ahead: $ahead,
      commit: (if $commit == "" then null else $commit end)}'
}

last_fetch=
interrupted=1
# Checks in with the board, and updates it when someone has asked for that.
check_in() {
  local branch status
  branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || branch=origin/main
  branch=${branch#origin/}
  if [[ -z $last_fetch ]] || ((SECONDS - last_fetch >= UPDATE_FETCH_SECONDS)); then
    as_owner timeout 60 git -C "$REPO" fetch --quiet origin "$branch" 2>/dev/null
    last_fetch=$SECONDS
  fi
  status=$(report "$(checkout_state "$branch")") || return 0
  # An update this script was doing when it stopped.
  if [[ -n $interrupted && $(jq -r .state <<<"$status") == running ]]; then
    report '{"state":"failed","message":"The updater stopped during the update. Ask for it again."}' >/dev/null
  fi
  interrupted=
  [[ $(jq -r .state <<<"$status") == requested ]] && update_board "$branch"
}

# The docker compose command for this container's project: its name, the checkout, and the compose files it was started
# with, mapped from their paths on the host (labels on this container) to the checkout's mount. Sets update_board's
# compose, project and service, or error.
compose_command() {
  local labels dir file files
  labels=$(docker inspect --format '{{json .Config.Labels}}' "$HOSTNAME" 2>&1) || {
    error="couldn't inspect this container: $(tail -c 500 <<<"$labels")"
    return 1
  }
  project=$(jq -r '."com.docker.compose.project" // empty' <<<"$labels")
  service=$(jq -r '."com.docker.compose.service" // empty' <<<"$labels")
  dir=$(jq -r '."com.docker.compose.project.working_dir" // empty' <<<"$labels")
  [[ -n $project && -n $dir ]] || {
    error="this container wasn't started with docker compose"
    return 1
  }
  compose=(docker compose -p "$project" --project-directory "$REPO")
  IFS=, read -ra files <<<"$(jq -r '."com.docker.compose.project.config_files" // empty' <<<"$labels")"
  for file in "${files[@]}"; do
    if [[ $file != "$dir"[/\\]* ]]; then
      error="the board was started with $file, which isn't in the checkout ($dir)"
      return 1
    fi
    file=${file#"$dir"}
    compose+=(-f "$REPO${file//\\//}")
  done
}

# Before update_board moves the checkout to origin's branch, keeps what that would drop: local changes in a git stash,
# and commits that would be on no branch any more (the default branch's own, or a detached HEAD's) on a backup branch.
# Adds where to update_board's kept: `keep_local_work <git command for the checkout...>`.
keep_local_work() {
  local stamp output count identity=()
  stamp=$(date -u +%Y%m%d-%H%M%S)
  # The stash commit needs an author.
  "$@" config user.email >/dev/null ||
    identity=(-c user.name=ultrakanban-updater -c user.email=updater@ultrakanban.invalid)
  if [[ -n $("$@" status --porcelain --untracked-files=no) ]]; then
    if ! output=$("$@" ${identity[@]+"${identity[@]}"} stash push --quiet --message "ultrakanban update $stamp" 2>&1)
    then
      update_failed "Couldn't stash the checkout's local changes: $(tail -c 1500 <<<"$output")"
      return 1
    fi
    kept+="${kept:+, and }its local changes in the git stash \"ultrakanban update $stamp\""
  fi
  count=$("$@" rev-list --count "origin/$branch..refs/heads/$branch" 2>/dev/null) || count=0
  if ((count > 0)); then
    "$@" branch "ultrakanban-backup-$stamp" "refs/heads/$branch" || {
      update_failed "Couldn't keep $branch's own commits on the branch ultrakanban-backup-$stamp."
      return 1
    }
    kept+="${kept:+, and }$count commit(s) of $branch's own on the branch ultrakanban-backup-$stamp"
  fi
  "$@" symbolic-ref --quiet HEAD >/dev/null && return
  count=$("$@" rev-list --count HEAD --not --branches --remotes 2>/dev/null) || count=0
  if ((count > 0)); then
    "$@" branch "ultrakanban-backup-$stamp-detached" HEAD || {
      update_failed "Couldn't keep the detached HEAD's commits on the branch ultrakanban-backup-$stamp-detached."
      return 1
    }
    kept+="${kept:+, and }the detached HEAD's $count commit(s) on the branch ultrakanban-backup-$stamp-detached"
  fi
}

# Moves the checkout to origin's default branch, whatever it had checked out, then rebuilds and restarts the board on
# it: `update_board <branch>`. It keeps what that would drop (see keep_local_work), and says where.
update_board() {
  local branch=$1 output error project service compose services running commit waited=0 kept=
  update_failed() {
    echo "update failed: $1"
    report "$(jq -nc --arg message "$1${kept:+ Kept $kept.}" --argjson fields "$(checkout_state "$branch")" \
      '$fields + {state: "failed", message: $message}')" >/dev/null
  }
  # Taking the request fails when it was withdrawn meanwhile.
  report "$(jq -nc --arg message "Updating to origin/$branch" '{state: "running", message: $message}')" >/dev/null ||
    return 0
  echo "updating ultrakanban: moving to origin/$branch"

  if ! output=$(as_owner timeout 300 git -C "$REPO" fetch --quiet origin "$branch" 2>&1); then
    update_failed "git fetch origin $branch failed: $(tail -c 1500 <<<"$output")"
    return
  fi
  last_fetch=$SECONDS
  # git runs with HOME=/tmp here, so only the checkout's own config has an author for the stash.
  keep_local_work git || return
  if ! output=$(git checkout --quiet -B "$branch" "origin/$branch" 2>&1); then
    update_failed "git checkout -B $branch origin/$branch failed: $(tail -c 1500 <<<"$output")"
    return
  fi

  if ! compose_command; then
    update_failed "Moved to $(git log -1 --format='%h %s'), but $error, so restart the board yourself."
    return
  fi
  # The containers running now, except this one.
  mapfile -t services < <(docker ps --filter "label=com.docker.compose.project=$project" \
    --format '{{.Label "com.docker.compose.service"}}' | grep -vxF "$service" | sort -u)
  echo "rebuilding and restarting ${services[*]}"
  # ULTRAKANBAN_COMMIT: the commit the app is built from, so the app and this script can tell it runs this one.
  commit=$(git rev-parse HEAD)
  if ! output=$(ULTRAKANBAN_COMMIT=$commit "${compose[@]}" up -d --build "${services[@]}" 2>&1); then
    update_failed "Rebuilding the board failed: $(tail -c 1500 <<<"$output")"
    return
  fi
  # The app restarts with the new build; wait for it to answer again, so the report gets through.
  until running=$(curl -sf "$KANBAN/api/system/update") || ((waited >= 300)); do
    sleep 5
    ((waited += 5))
  done
  running=$(jq -r '.runningCommit // empty' <<<"$running" 2>/dev/null)
  if [[ -n $running && $running != "$commit" ]]; then
    update_failed "Rebuilt the board on ${commit:0:7}, but it still runs ${running:0:7}. Restart it yourself with \
docker compose up -d --force-recreate."
    return
  fi
  echo "updated ultrakanban to $(git log -1 --format='%h %s')"
  report "$(jq -nc --arg message "Updated to $(git log -1 --format='%h %s')${kept:+; kept $kept}" \
    --argjson fields "$(checkout_state "$branch")" '$fields + {state: "done", message: $message}')" \
    >/dev/null || echo "couldn't report the update to $KANBAN"
  echo "restarting with the new deploy/updater.sh"
  exec bash "$self"
}

echo "updating ultrakanban in $REPO when asked for it at $KANBAN"
while true; do
  check_in
  sleep "$POLL_SECONDS"
done

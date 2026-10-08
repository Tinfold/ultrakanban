#!/usr/bin/env bash
# The updater container (docker compose --profile updater, deploy/updater.Dockerfile): updates ultrakanban when someone
# asks for it in the app (the update button in the header) where no agent supervisor on the machine does, because there
# are no systemd user services: Windows and macOS with Docker Desktop, Linux without systemd. It does what the
# supervisor's check_in and update_board do (scripts/agent-supervisor.sh): every POLL_SECONDS it checks in with the
# checkout's version and how many commits it is behind origin (fetched every UPDATE_FETCH_SECONDS), and when an update
# has been asked for it pulls the checkout's default branch, then rebuilds and restarts the compose project's running
# containers with the compose files they were started with (e.g. deploy/compose.gpu.yml), and reports how it went.
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

# The checkout's version and how far its default branch is behind origin, as report fields.
checkout_state() {
  local branch=$1 behind
  behind=$(git rev-list --count "$branch..origin/$branch" 2>/dev/null) || behind=null
  jq -nc --arg version "$(git log -1 --format='%h %s' 2>/dev/null)" --argjson behind "$behind" \
    '{version: (if $version == "" then null else $version end), behind: $behind}'
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

# Pulls the checkout's default branch, then rebuilds and restarts the board on it.
update_board() {
  local branch=$1 current output error project service compose services waited=0
  update_failed() {
    echo "update failed: $1"
    report "$(jq -nc --arg message "$1" --argjson fields "$(checkout_state "$branch")" \
      '$fields + {state: "failed", message: $message}')" >/dev/null
  }
  # Taking the request fails when it was withdrawn meanwhile.
  report "$(jq -nc --arg message "Pulling $branch" '{state: "running", message: $message}')" >/dev/null || return 0
  echo "updating ultrakanban: pulling $branch"

  current=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)
  if [[ $current != "$branch" ]]; then
    update_failed "The checkout has ${current:-a detached HEAD} checked out, not $branch. Switch it back to $branch to update."
    return
  fi
  if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
    update_failed "The checkout has local changes. Commit or stash them to update."
    return
  fi
  if ! output=$(as_owner timeout 300 git -C "$REPO" pull --ff-only --quiet origin "$branch" 2>&1); then
    update_failed "git pull failed: $(tail -c 1500 <<<"$output")"
    return
  fi
  last_fetch=$SECONDS

  if ! compose_command; then
    update_failed "Pulled $(git log -1 --format='%h %s'), but $error, so restart the board yourself."
    return
  fi
  # The containers running now, except this one.
  mapfile -t services < <(docker ps --filter "label=com.docker.compose.project=$project" \
    --format '{{.Label "com.docker.compose.service"}}' | grep -vxF "$service" | sort -u)
  echo "rebuilding and restarting ${services[*]}"
  if ! output=$("${compose[@]}" up -d --build "${services[@]}" 2>&1); then
    update_failed "Rebuilding the board failed: $(tail -c 1500 <<<"$output")"
    return
  fi
  # The app restarts with the new build; wait for it to answer again, so the report gets through.
  until curl -sf "$KANBAN/api/system/update" >/dev/null || ((waited >= 300)); do
    sleep 5
    ((waited += 5))
  done
  echo "updated ultrakanban to $(git log -1 --format='%h %s')"
  report "$(jq -nc --arg message "Updated to $(git log -1 --format='%h %s')" \
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

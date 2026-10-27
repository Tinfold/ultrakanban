# Handing tickets to runs: closed pull requests, requeued tickets, new feedback and claiming new tickets.
# Part of agent-loop.sh, which sources it; the settings it uses are described there.

# Moves a ticket whose pull request was closed without merging to the cancelled column.
cancel() {
  local id=$1 number=$2 pr_url=$3 cancelled=$4 holder=$5 response
  if [[ -z $cancelled ]]; then
    log "error: ticket #$number ($id): $pr_url was closed without merging, but the board has no \
\"$CANCELLED_COLUMN\" column; leaving the ticket alone"
    return 1
  fi
  response=$(post "/tickets/$id/release" "$(jq -nc --arg agent "$holder" --arg moveTo "$cancelled" \
    '{agent: $agent, moveTo: $moveTo}')" "$holder")
  if [[ ${response##*$'\n'} != 200 ]]; then
    log "error: ticket #$number ($id): can't move it to $CANCELLED_COLUMN: ${response%$'\n'*}"
    return 1
  fi
  note "$id" "Pull request $pr_url was closed without merging, so the ticket moved to $CANCELLED_COLUMN."
  rm -f "$(state_file "$id")"
  remove_scratch "$id"
  log "ticket #$number ($id): $pr_url was closed without merging; moved it to $CANCELLED_COLUMN"
}

# Releases a ticket in the todo column or one before it (someone moved it back there), so that it is claimed again
# like any other ticket, and forgets its state and unfinished work.
requeue() {
  local id=$1 number=$2 holder=$3 column=$4 response
  response=$(post "/tickets/$id/release" "$(jq -nc --arg agent "$holder" '{agent: $agent}')" "$holder")
  if [[ ${response##*$'\n'} != 200 ]]; then
    log "error: ticket #$number ($id): can't release it from $column: ${response%$'\n'*}"
    return 1
  fi
  rm -f "$(state_file "$id")"
  remove_scratch "$id"
  if [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then git update-ref -d "refs/ultrakanban/work/$id" 2>/dev/null; fi
  if [[ ${column,,} == "${TODO_COLUMN,,}" ]]; then
    note "$id" "The ticket is back in $column, so the agent released it. It will be claimed again from there like \
any other ticket."
  else
    note "$id" "The ticket was moved to $column, so the agent released it. Move it to $TODO_COLUMN when it should be \
worked on again."
  fi
  log "ticket #$number ($id): moved back to $column; released it"
}

# Sets the worker for a run on feedback: the ticket's own model and effort (- when it has none), else the setting the
# board routed it to when it routes with Jev (kept from the claim, so Jev isn't asked again while the ticket doesn't
# change), else MODEL and EFFORT.
use_ticket_worker() {
  local id=$1 model=${2#-} effort=${3#-} response routed=
  if [[ -z $model && -z $effort ]]; then
    response=$(post "/tickets/$id/route" '{}')
    if [[ ${response##*$'\n'} == 200 ]]; then
      routed=$(jq -r '.routed // empty | "\(.model)\t\(.effort)"' <<<"${response%$'\n'*}") || routed=
    fi
    if [[ -n $routed ]]; then
      model=${routed%%$'\t'*}
      effort=${routed#*$'\t'}
    fi
  fi
  use_worker "$model" "$effort"
}

# Sets the worker for a run only to fix merge conflicts (trigger conflict) or failing CI (trigger ci): the board's
# setting for those, from the conflict model, conflict effort, CI model and CI effort, tab-separated. Returns 1 for
# any other run.
use_fix_worker() {
  local conflict_model conflict_effort ci_model ci_effort
  IFS=$'\t' read -r conflict_model conflict_effort ci_model ci_effort <<<"$2"
  case $1 in
    conflict) use_worker "$conflict_model" "$conflict_effort" ;;
    ci) use_worker "$ci_model" "$ci_effort" ;;
    *) return 1 ;;
  esac
}

# Reassigns a ticket held under another of the agent's names (another model or effort, or the bare agent name) to
# the worker set by use_worker, in one versioned update.
adopt() {
  local id=$1 number=$2 holder=$3 version=$4 response
  [[ $holder == "$worker" ]] && return 0
  response=$(post "/tickets/$id" "$(jq -nc --arg assignee "$worker" --argjson version "$version" \
    '{assignee: $assignee, ifVersion: $version}')" "$LOOP_ACTOR" PATCH)
  if [[ ${response##*$'\n'} != 200 ]]; then
    log "error: ticket #$number ($id): can't reassign it from $holder to $worker: ${response%$'\n'*}"
    return 1
  fi
  log "ticket #$number ($id): reassigned from $holder to $worker"
}

# What the loop reads of a pull request, from gh pr list or gh pr view.
PR_FIELDS=state,updatedAt,mergeable,mergeStateStatus,headRefOid,headRefName,baseRefOid,baseRefName

# Reads an open pull request's comments, reviews, inline comments and checks into issue, reviews, inline and ci. They
# are kept in STATE_DIR/github/<ticket>.json and used again while the pull request (gh pr list or view) is unchanged:
# same updatedAt and head commit, no checks still running, and read less than PR_RECHECK_SECONDS ago. Each of the
# calls this spares costs GitHub API rate limit, several per pull request and round. Returns 1 if GitHub can't be read.
read_pr_feedback() {
  local id=$1 url=$2 repo=$3 number=$4 pr=$5 file sha cached now
  file="$STATE_DIR/github/$id.json"
  sha=$(jq -r .headRefOid <<<"$pr")
  now=$(date +%s)
  cached=$(jq -c --arg url "$url" --arg sha "$sha" --argjson pr "$pr" --argjson now "$now" \
    --argjson max "$PR_RECHECK_SECONDS" 'select(.url == $url and .sha == $sha and $pr.updatedAt != null
      and .updatedAt == $pr.updatedAt and .ci.pending == false and $now - .at < $max)' "$file" 2>/dev/null)
  if [[ -n $cached ]]; then
    issue=$(jq -c .issue <<<"$cached") reviews=$(jq -c .reviews <<<"$cached") inline=$(jq -c .inline <<<"$cached")
    ci=$(jq -c .ci <<<"$cached")
    return 0
  fi
  # The account the agent posts from (see TRIAGE), read once.
  [[ -n $gh_login ]] || gh_login=$(gh api user --jq .login </dev/null 2>/dev/null) || gh_login=
  issue=$(gh_list "repos/$repo/issues/$number/comments?per_page=100") &&
    reviews=$(gh_list "repos/$repo/pulls/$number/reviews?per_page=100") &&
    inline=$(gh_list "repos/$repo/pulls/$number/comments?per_page=100") ||
    { log "can't read the comments on $url"; return 1; }
  ci=$(ci_status "$repo" "$sha") || { log "can't read the checks on $url"; return 1; }
  printf '%s\n' "$issue" "$reviews" "$inline" "$ci" |
    jq -cs --arg url "$url" --arg sha "$sha" --argjson pr "$pr" --argjson now "$now" \
      '{url: $url, sha: $sha, updatedAt: $pr.updatedAt, at: $now, issue: .[0], reviews: .[1], inline: .[2], ci: .[3]}' \
      >"$file.tmp" && mv "$file.tmp" "$file" || rm -f "$file.tmp"
}

# Checks the tickets the agent holds and handles the first one that needs work. Returns 1 if none did. A conflict loop
# (CONFLICTS_ONLY) only handles tickets in the review column whose pull request has merge conflicts, and the human
# feedback on the ticket it last ran (its `followup`) that came in during that run: left to the loops that work tickets,
# that feedback could wait hours for one of them to be free.
handle_feedback() {
  local board review cancelled idle tickets file id number column holder version ticket_model ticket_effort pr_url repo pr_number \
    queued approval conflicts pr pr_state branch listed open_prs list after ci issue reviews inline comments activity \
    state triage items ci_note next fix_runs fix local_repo \
    local_pr='^(https?://[^/]+)?/b/([[:alnum:]_-]+)/pr/([0-9]+)([/?#].*)?$'
  claim_lock -s
  # Read again under the claim lock: the round's board may be from before another loop claimed a ticket, which would
  # look as if the agent didn't hold it (see claim_lock), and the rest of the round reads this fresher copy.
  refresh_board
  board=$(board) || { claim_unlock; log "can't read board $BOARD"; return 1; }
  # A board with a local repository has nothing on GitHub to read: its pull requests are local ones, on the board.
  local_repo=$(jq -r '.board.localRepoPath // ""' <<<"$board")
  review=$(jq -r '.board.reviewColumnId // ""' <<<"$board")
  cancelled=$(jq -r --arg name "$CANCELLED_COLUMN" \
    '[.columns[] | select((.name | ascii_downcase) == ($name | ascii_downcase)) | .id][0] // ""' <<<"$board")
  idle=$(idle_columns "$board") || { claim_unlock; log "can't read the columns of board $BOARD"; return 1; }
  # The model and effort for runs only to fix merge conflicts, then for those only to fix failing CI.
  fix_runs=$(jq -r '.board | [.agentConflictModel // "sonnet", .agentConflictEffort // "medium",
    .agentCiModel // "sonnet", .agentCiEffort // "medium"] | @tsv' <<<"$board")
  tickets=$(jq -r --arg agent "$AGENT" --arg cancelled "$cancelled" --argjson idle "$idle" \
    '(.board.doneColumnId // "") as $done
    | .tickets[] | select(.assignee | . != null and (. == $agent or startswith($agent + "/")))
    | select(.columnId != $done and .columnId != $cancelled)
    | [.id, .number, .columnId, .assignee, .version, .agentModel // "-", .agentEffort // "-", .pullRequest.url // "-",
       .pullRequest.repo // "-", .pullRequest.number // "-",
       ($idle[.columnId] | if .queued then .name else "-" end), .approval // "-", .pullRequest.conflicts // false]
    | @tsv' \
    <<<"$board")
  board=

  # Forget tickets the agent no longer holds, and their unfinished work.
  for file in "$STATE_DIR"/*.json "$STATE_DIR"/*.lock "$STATE_DIR"/github/*.json; do
    [[ -e $file && $file != */claim.lock ]] || continue
    id=${file##*/}
    id=${id%.*}
    [[ $'\n'$tickets == *$'\n'"$id"$'\t'* ]] && continue
    rm -f "$file"
    if [[ $file == "$STATE_DIR/$id.json" ]]; then remove_scratch "$id"; fi
  done
  if [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then
    for id in $(git for-each-ref --format='%(refname:lstrip=3)' refs/ultrakanban/work/); do
      [[ $'\n'$tickets == *$'\n'"$id"$'\t'* ]] || git update-ref -d "refs/ultrakanban/work/$id"
    done
  fi
  claim_unlock

  # The open pull requests of the repositories the tickets' pull requests are in, listed once per repository as they
  # come up: {repo: {number: pull request}}. One that isn't listed (closed, merged, or the list failed) is read alone.
  listed=$'\n' open_prs='{}'
  while IFS=$'\t' read -r -u 3 id number column holder version ticket_model ticket_effort pr_url repo pr_number queued \
    approval conflicts; do
    [[ -n $id ]] || continue
    # The board's view of the pull request (synced from GitHub every minute) spares a conflict loop reading GitHub for
    # tickets without conflicts; whether there are any now is checked with GitHub below.
    [[ $CONFLICTS_ONLY == 1 && $id != "$followup" && ($column != "$review" || $conflicts != true) ]] && continue
    # Another loop is working this one.
    unlock_ticket
    lock_ticket "$id" || continue
    if [[ $queued != - ]]; then
      requeue "$id" "$number" "$holder" "$queued"
      continue
    fi
    pr=null pr_state= branch= ci=null issue='[]' reviews='[]' inline='[]' comments='[]'
    if [[ $pr_url =~ $local_pr ]]; then
      # A local pull request, on the board rather than on GitHub (a board with a local repository): read from the
      # board, its comments (inline ones too) count as feedback as GitHub's do. It has no checks.
      pr=$(get "/boards/${BASH_REMATCH[2]}/pull-requests/${BASH_REMATCH[3]}") || { log "can't read $pr_url"; continue; }
      pr_state=$(jq -r '.state | ascii_upcase' <<<"$pr")
      if [[ $pr_state == OPEN ]]; then
        branch=$(jq -r .head <<<"$pr")
        comments=$(jq -c .comments <<<"$pr")
        pr=$(jq -c --arg url "$KANBAN/b/${BASH_REMATCH[2]}/pr/${BASH_REMATCH[3]}" \
          '{state: "OPEN", headRefName: .head, baseRefName: .base, url: $url}' <<<"$pr")
      fi
    elif [[ $pr_url != - && -z $local_repo ]]; then
      if [[ $repo != - && $listed != *$'\n'"$repo"$'\n'* ]]; then
        listed+="$repo"$'\n'
        list=$(gh pr list --repo "$repo" --state open --limit 1000 --json "number,$PR_FIELDS" </dev/null |
          jq -c --arg repo "$repo" \
            '{($repo): (map({key: (.number | tostring), value: del(.number)}) | from_entries)}') &&
          open_prs=$(printf '%s\n' "$open_prs" "$list" | jq -cs add) || log "can't list the pull requests of $repo"
      fi
      pr=$(jq -c --arg repo "$repo" --arg number "$pr_number" '.[$repo][$number] // empty' <<<"$open_prs")
      [[ -n $pr ]] || pr=$(gh pr view "$pr_url" --json "$PR_FIELDS" </dev/null) ||
        { log "can't read $pr_url"; continue; }
      pr_state=$(jq -r .state <<<"$pr")
      if [[ $pr_state == OPEN ]]; then
        branch=$(jq -r .headRefName <<<"$pr")
        if ! read_pr_feedback "$id" "$pr_url" "$repo" "$pr_number" "$pr"; then continue; fi
      fi
    fi
    if [[ $pr_state == CLOSED && $column == "$review" ]]; then
      cancel "$id" "$number" "$pr_url" "$cancelled" "$holder" && { unlock_ticket; return 0; }
      continue
    fi
    [[ $pr_state == OPEN ]] || pr=null

    state=$(read_state "$id")
    # Only the activity newer than what the state has already seen (the lower of its snapshot and its stopped run's).
    after=$(jq -r '[.activity // 0, (.stopped | objects | .activity // 0)] | min' <<<"$state")
    activity=$(get "/tickets/$id/activity?afterId=$after") || { log "can't read the activity of $id"; continue; }
    triage=$(printf '%s\n' "$activity" "$pr" "$ci" "$issue" "$reviews" "$inline" "$comments" "$state" |
      jq -cs --arg agent "$AGENT" --arg loop "$LOOP_ACTOR" --arg marker "$MARKER" --arg working "$IN_PROGRESS_COLUMN" \
        --argjson inreview "$([[ -n $review && $column == "$review" ]] && echo true || echo false)" \
        --arg ghlogin "$gh_login" \
        --argjson now "$(date +%s)" --argjson retry "$RETRY_SECONDS" --argjson max "$MAX_ATTEMPTS" \
        --argjson maxci "$MAX_CI_RUNS" --argjson maxconflict "$MAX_CONFLICT_RUNS" "$TRIAGE") ||
      { log "can't triage $id"; continue; }
    activity= pr= ci= issue= reviews= inline= comments=

    if [[ $(jq -r '.infraNote != null' <<<"$triage") == true ]]; then
      ci_note=$(jq -r '.infraNote | "CI on \(.sha[:7]) didn'"'"'t run properly, so no agent run was started for it: "
        + (.infra | map("\(.name) (\(.why))") | join("; "))' <<<"$triage")
      log "ticket #$number ($id): $ci_note"
      note "$id" "$ci_note. Someone needs to check CI (billing and spending limits, runners, approvals)." notify
      update_state "$id" '.infraNoted = $v' "$(jq -r .infraNote.sha <<<"$triage")"
    fi
    if [[ $(jq -r .capNote <<<"$triage") == true ]]; then
      log "ticket #$number ($id): $MAX_CI_RUNS runs in a row for failing CI; not starting more until a human comments"
      note "$id" "The agent made $MAX_CI_RUNS runs in a row for failing CI with no human feedback in between, so the \
loop stopped starting runs for CI on this ticket. Comment on the ticket to let it try again." notify
      update_state "$id" '.capNoted = true'
    fi
    if [[ $(jq -r .conflictCapNote <<<"$triage") == true ]]; then
      log "ticket #$number ($id): $MAX_CONFLICT_RUNS runs in a row for merge conflicts; not starting more until a human comments"
      note "$id" "The agent made $MAX_CONFLICT_RUNS runs in a row for merge conflicts with no human feedback in between, \
so the loop stopped starting runs for conflicts on this ticket. Comment on the ticket to let it try again." notify
      update_state "$id" '.conflictCapNoted = true'
    fi
    if [[ $CONFLICTS_ONLY == 1 ]] && ! jq -e --arg id "$id" --arg followup "$followup" \
      '.conflicted or ($id == $followup and .human)' <<<"$triage" >/dev/null; then
      [[ $id == "$followup" ]] && followup=
      continue
    fi
    [[ $(jq -r .run <<<"$triage") == true ]] || continue

    # A run only to fix merge conflicts or failing CI also starts a session of its own (see run_on_ticket).
    fix=1
    use_fix_worker "$(jq -r '.trigger // ""' <<<"$triage")" "$fix_runs" ||
      { fix=0; use_ticket_worker "$id" "$ticket_model" "$ticket_effort"; }
    adopt "$id" "$number" "$holder" "$version" || continue
    items=$(jq -r '.items | map(.text) | join("\n\n---\n\n")' <<<"$triage")
    run_step=$(jq -r '.items | map(.text | split("\n")[0] | rtrimstr(":")) | join("; ")' <<<"$triage")
    log "ticket #$number ($id): $run_step"
    run_step=${run_step:0:200}
    if [[ $approval == pending ]]; then
      next="The ticket's plan waits for a person to approve it, so don't start the work yet: answer the feedback above,
post a revised plan (POST $KANBAN/api/tickets/$id/plan) if it asks for changes to the plan, and exit."
    else
      next="If the ticket isn't in review yet, keep working it and submit it for review, unless the feedback above says
otherwise."
    fi
    [[ $CONFLICTS_ONLY == 1 ]] && followup=$id
    run_on_ticket "$id" "Ticket $id is already yours. The loop started this run for this new feedback:

$items

The new feedback is above; fetch more only if you need context. Address everything above: answer questions, make the requested changes, fix failing checks, and resolve merge
conflicts by rebasing the pull request's branch onto the base branch (not by merging the base branch in), keeping both
sides' changes in every conflict: check that git diff origin/<base>...HEAD shows only the pull request's own changes.
Commit and push to that branch, with git push --force-with-lease after a rebase.
Reply where each piece of feedback was given: on the pull request for pull request feedback (with the marker line).
$next$(
      [[ $(jq -r .ci <<<"$triage") == true ]] && printf '%s' "
Failing CI started this run. First find out from the failing job's log whether the failure comes from the code. If it
doesn't (billing or spending limits, runners or infrastructure, a flaky test unrelated to the change, missing
secrets), don't push anything: explain what you found in the ticket comment and exit.")
Finish with a ticket comment summarising what you did, then exit." \
      "$(jq -c .snapshot <<<"$triage")" "$(jq -r .fingerprint <<<"$triage")" "$(jq -r .ciRuns <<<"$triage")" "$branch" \
      "$([[ $approval == pending ]] && echo 0 || echo 1)" "$fix"
    unlock_ticket
    return 0
  done 3<<<"$tickets"
  unlock_ticket
  return 1
}

# Whether the agent may take a ticket from the backlog column: the board allows it and has that column, and the
# in-progress column holds fewer than CLAIM_LIMIT (the board's parallel runs) tickets. Tickets already in progress
# take up the slots, so the backlog isn't pulled into progress while they're being worked.
backlog_on() {
  board | jq -e --arg name "$BACKLOG_COLUMN" --arg progress "$IN_PROGRESS_COLUMN" \
    --argjson limit "$CLAIM_LIMIT" '
    def column($n): first(.columns[] | select((.name | ascii_downcase) == ($n | ascii_downcase)) | .id) // null;
    column($progress) as $p
    | .board.agentBacklog and column($name) != null
      and ([.tickets[] | select($p != null and .columnId == $p)] | length) < $limit' >/dev/null
}

# How many tickets the agent claimed whose first run hasn't finished yet: going, failed (waiting to be retried, or
# for feedback after MAX_ATTEMPTS) or stopped. Their state still has the claim; a run that finishes drops it.
pending_claims() {
  local files=("$STATE_DIR"/*.json)
  [[ -e ${files[0]} ]] || { echo 0; return; }
  jq -s 'map(select(type == "object" and .claim == true)) | length' "${files[@]}" 2>/dev/null || echo 0
}

# Claims the next ticket from the given column; prints the response body and then the HTTP status on its own line.
claim_from() {
  post "/boards/$BOARD/tickets/claim-next" "$(jq -nc --arg agent "$worker" --arg column "$1" \
    --arg moveTo "$IN_PROGRESS_COLUMN" '{agent: $agent, column: $column, moveTo: $moveTo}')"
}

# Claims the next ticket from the todo column (then the backlog column, if the board allows it) and works it.
# Returns 1 if there was nothing to claim, or if CLAIM_LIMIT claimed tickets are still waiting for their first run
# to finish: those are worked (or retried) first, rather than claiming ticket after ticket while runs keep failing.
# A conflict loop (CONFLICTS_ONLY) never claims one.
claim_next() {
  local response status ticket id snapshot pending plan_note=
  [[ $CONFLICTS_ONLY == 1 ]] && return 1
  paused && return 0
  use_worker "" ""
  claim_lock -x
  pending=$(pending_claims)
  if ((pending >= CLAIM_LIMIT)); then
    claim_unlock
    [[ $claim_held == "$pending" ]] || log "not claiming more tickets: $pending claimed ticket(s) haven't finished \
their first run yet (CLAIM_LIMIT $CLAIM_LIMIT)"
    claim_held=$pending
    return 1
  fi
  claim_held=
  response=$(claim_from "$TODO_COLUMN")
  status=${response##*$'\n'}
  ticket=${response%$'\n'*}
  if [[ $status == 404 && $ticket == *no_ticket_available* ]] && backlog_on; then
    response=$(claim_from "$BACKLOG_COLUMN")
    status=${response##*$'\n'}
    ticket=${response%$'\n'*}
  fi
  if [[ $status == 429 && $ticket == *usage_reserve_reached* ]]; then
    # Agents leave the rest of the week's or the current session's Claude usage to people (the usage reserve, set on
    # the overview next to the Claude usage). Tickets the agent holds still get runs; only claiming waits, and the
    # board says why.
    claim_unlock
    [[ -n $reserve_held ]] || log "not claiming new tickets: $(jq -r '.error.message // empty' <<<"$ticket")"
    reserve_held=1
    return 1
  fi
  if [[ -n $reserve_held && ($status == 200 || $ticket == *no_ticket_available*) ]]; then
    log "Claude usage is below the usage reserve again: claiming new tickets"
    reserve_held=
  fi
  if [[ $status != 200 ]]; then
    claim_unlock
    [[ $status == 404 && $ticket == *no_ticket_available* ]] || log "claim failed (HTTP ${status:-none}): $ticket"
    return 1
  fi

  id=$(jq -r .id <<<"$ticket")
  log "ticket #$(jq -r .number <<<"$ticket") ($id): claimed: $(jq -r .title <<<"$ticket")"
  if ! lock_ticket "$id"; then
    # Can't happen while every loop takes the claim lock; leave the ticket to whichever loop has it.
    claim_unlock
    log "ticket #$(jq -r .number <<<"$ticket") ($id): another loop is already working it"
    return 0
  fi
  # The claim can't know the ticket's model and effort beforehand, so a ticket that sets them, or that the board routed
  # (its routed setting, on a board that routes with Jev), is handed to that worker now.
  use_worker "$(jq -r '.routed.model // .agentModel // ""' <<<"$ticket")" \
    "$(jq -r '.routed.effort // .agentEffort // ""' <<<"$ticket")"
  adopt "$id" "$(jq -r .number <<<"$ticket")" "$WORKER" "$(jq -r .version <<<"$ticket")" || use_worker "" ""
  # Everything on the ticket so far is handed to this run. Until it succeeds, the claim itself counts as feedback,
  # so a failed or interrupted run is retried with backoff.
  snapshot=$(get "/tickets/$id/activity" | jq -c '{activity: (map(.id) | max // 0)}') || snapshot='{}'
  # A re-claimed ticket may already have a pull request. Its comments and reviews so far may ask for changes no run was
  # handed (they came while no one held the ticket, or another agent did), so this run is told to read them (pr_note),
  # and they go into the snapshot too rather than coming back as new feedback.
  local pr_repo pr_number issue reviews inline pr_note=
  pr_repo=$(jq -r '.pullRequest.repo // empty' <<<"$ticket")
  pr_number=$(jq -r '.pullRequest.number // empty' <<<"$ticket")
  if [[ -n $pr_repo && -n $pr_number ]]; then
    pr_note="
The ticket already has a pull request, $(jq -r .pullRequest.url <<<"$ticket"): read its comments, reviews and inline \
review comments first (see the skill), and address what they ask for that isn't done yet."
    if issue=$(gh_list "repos/$pr_repo/issues/$pr_number/comments?per_page=100") &&
      reviews=$(gh_list "repos/$pr_repo/pulls/$pr_number/reviews?per_page=100") &&
      inline=$(gh_list "repos/$pr_repo/pulls/$pr_number/comments?per_page=100"); then
      snapshot=$(jq -c --argjson i "$issue" --argjson r "$reviews" --argjson c "$inline" \
        '. + {issue: ([$i[].id] | max // 0), review: ([$r[].id] | max // 0), inline: ([$c[].id] | max // 0)}' \
        <<<"$snapshot") || true
    fi
  fi
  write_state "$id" "$(jq -c '. + {claim: true}' <<<"$snapshot")"
  claim_unlock
  run_step="Working the ticket"
  if board | jq -e '.board.approvalSize == null' >/dev/null 2>&1; then
    plan_note=" No plans wait for approval on this board, so for a small ticket a one-line plan is enough (or skip it)."
  fi
  run_on_ticket "$id" "Ticket $id is already claimed for you and in progress. Work only this ticket; do not claim another.
Take it through to review and exit after submitting it. If it is tagged question, submit it for review with the answer \
as the comment and no pull request.$pr_note
Before you start the work, post your plan with its size estimate (POST $KANBAN/api/tickets/$id/plan, see the skill).$plan_note If \
the ticket then waits for approval (its \"approval\" is \"pending\"), stop there and exit: the loop starts a new run once \
someone approves the plan." "$snapshot" "claim"
  unlock_ticket
  return 0
}

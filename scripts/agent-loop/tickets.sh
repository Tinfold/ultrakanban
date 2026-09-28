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

# Checks the tickets the agent holds and handles the first one that needs work. Returns 1 if none did.
handle_feedback() {
  local board review cancelled idle tickets file id number column holder version ticket_model ticket_effort pr_url repo pr_number \
    queued pr branch ci issue reviews inline activity state triage items ci_note
  claim_lock -s
  board=$(get "/boards/$BOARD") || { claim_unlock; log "can't read board $BOARD"; return 1; }
  review=$(jq -r '.board.reviewColumnId // ""' <<<"$board")
  cancelled=$(jq -r --arg name "$CANCELLED_COLUMN" \
    '[.columns[] | select((.name | ascii_downcase) == ($name | ascii_downcase)) | .id][0] // ""' <<<"$board")
  idle=$(idle_columns "$board") || { claim_unlock; log "can't read the columns of board $BOARD"; return 1; }
  tickets=$(jq -r --arg agent "$AGENT" --arg cancelled "$cancelled" --argjson idle "$idle" \
    '(.board.doneColumnId // "") as $done
    | .tickets[] | select(.assignee | . != null and (. == $agent or startswith($agent + "/")))
    | select(.columnId != $done and .columnId != $cancelled)
    | [.id, .number, .columnId, .assignee, .version, .agentModel // "-", .agentEffort // "-", .pullRequest.url // "-",
       .pullRequest.repo // "-", .pullRequest.number // "-",
       ($idle[.columnId] | if .queued then .name else "-" end)] | @tsv' \
    <<<"$board")
  board=

  # Forget tickets the agent no longer holds, and their unfinished work.
  for file in "$STATE_DIR"/*.json "$STATE_DIR"/*.lock; do
    [[ -e $file && $file != */claim.lock ]] || continue
    id=${file##*/}
    id=${id%.*}
    [[ $'\n'$tickets == *$'\n'"$id"$'\t'* ]] || rm -f "$file"
  done
  if [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then
    for id in $(git for-each-ref --format='%(refname:lstrip=3)' refs/ultrakanban/work/); do
      [[ $'\n'$tickets == *$'\n'"$id"$'\t'* ]] || git update-ref -d "refs/ultrakanban/work/$id"
    done
  fi
  claim_unlock

  while IFS=$'\t' read -r -u 3 id number column holder version ticket_model ticket_effort pr_url repo pr_number queued; do
    [[ -n $id ]] || continue
    # Another loop is working this one.
    unlock_ticket
    lock_ticket "$id" || continue
    if [[ $queued != - ]]; then
      requeue "$id" "$number" "$holder" "$queued"
      continue
    fi
    pr=null branch= ci=null issue='[]' reviews='[]' inline='[]'
    if [[ $pr_url != - ]]; then
      pr=$(gh pr view "$pr_url" \
        --json state,mergeable,mergeStateStatus,headRefOid,headRefName,baseRefOid,baseRefName </dev/null) ||
        { log "can't read $pr_url"; continue; }
      case $(jq -r .state <<<"$pr") in
        OPEN)
          branch=$(jq -r .headRefName <<<"$pr")
          issue=$(gh_list "repos/$repo/issues/$pr_number/comments?per_page=100") &&
            reviews=$(gh_list "repos/$repo/pulls/$pr_number/reviews?per_page=100") &&
            inline=$(gh_list "repos/$repo/pulls/$pr_number/comments?per_page=100") ||
            { log "can't read the comments on $pr_url"; continue; }
          ci=$(ci_status "$repo" "$(jq -r .headRefOid <<<"$pr")") ||
            { log "can't read the checks on $pr_url"; continue; }
          ;;
        CLOSED)
          if [[ $column == "$review" ]]; then
            cancel "$id" "$number" "$pr_url" "$cancelled" "$holder" && { unlock_ticket; return 0; }
            continue
          fi
          pr=null
          ;;
        *) pr=null ;;
      esac
    fi

    activity=$(get "/tickets/$id/activity") || { log "can't read the activity of $id"; continue; }
    state=$(read_state "$id")
    triage=$(printf '%s\n' "$activity" "$pr" "$ci" "$issue" "$reviews" "$inline" "$state" |
      jq -cs --arg agent "$AGENT" --arg loop "$LOOP_ACTOR" --arg marker "$MARKER" --arg working "$IN_PROGRESS_COLUMN" \
        --argjson now "$(date +%s)" --argjson retry "$RETRY_SECONDS" --argjson max "$MAX_ATTEMPTS" \
        --argjson maxci "$MAX_CI_RUNS" "$TRIAGE") ||
      { log "can't triage $id"; continue; }
    activity= pr= ci= issue= reviews= inline=

    if [[ $(jq -r '.infraNote != null' <<<"$triage") == true ]]; then
      ci_note=$(jq -r '.infraNote | "CI on \(.sha[:7]) didn'"'"'t run properly, so no agent run was started for it: "
        + (.infra | map("\(.name) (\(.why))") | join("; "))' <<<"$triage")
      log "ticket #$number ($id): $ci_note"
      note "$id" "$ci_note. Someone needs to check CI (billing and spending limits, runners, approvals)."
      update_state "$id" '.infraNoted = $v' "$(jq -r .infraNote.sha <<<"$triage")"
    fi
    if [[ $(jq -r .capNote <<<"$triage") == true ]]; then
      log "ticket #$number ($id): $MAX_CI_RUNS runs in a row for failing CI; not starting more until a human comments"
      note "$id" "The agent made $MAX_CI_RUNS runs in a row for failing CI with no human feedback in between, so the \
loop stopped starting runs for CI on this ticket. Comment on the ticket to let it try again."
      update_state "$id" '.capNoted = true'
    fi
    [[ $(jq -r .run <<<"$triage") == true ]] || continue

    use_worker "${ticket_model#-}" "${ticket_effort#-}"
    adopt "$id" "$number" "$holder" "$version" || continue
    items=$(jq -r '.items | map(.text) | join("\n\n---\n\n")' <<<"$triage")
    log "ticket #$number ($id): $(jq -r '.items | map(.text | split("\n")[0] | rtrimstr(":")) | join("; ")' \
      <<<"$triage")"
    run_on_ticket "$id" "$(intro)

Ticket $id is already yours. The loop started this run for this new feedback:

$items

Read the ticket's activity and, if it has a pull request, its comments, reviews, inline review comments and checks,
then address everything above: answer questions, make the requested changes, fix failing checks, and resolve merge
conflicts by merging the base branch into the pull request's branch. Commit and push to that branch.
Reply where each piece of feedback was given: on the pull request for pull request feedback (with the marker line).
If the ticket isn't in review yet, keep working it and submit it for review, unless the feedback above says
otherwise.$(
      [[ $(jq -r .ci <<<"$triage") == true ]] && printf '%s' "
Failing CI started this run. First find out from the failing job's log whether the failure comes from the code. If it
doesn't (billing or spending limits, runners or infrastructure, a flaky test unrelated to the change, missing
secrets), don't push anything: explain what you found in the ticket comment and exit.")
Finish with a ticket comment summarising what you did, then exit." \
      "$(jq -c .snapshot <<<"$triage")" "$(jq -r .fingerprint <<<"$triage")" "$(jq -r .ciRuns <<<"$triage")" "$branch"
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
  get "/boards/$BOARD" | jq -e --arg name "$BACKLOG_COLUMN" --arg progress "$IN_PROGRESS_COLUMN" \
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
claim_next() {
  local response status ticket id snapshot pending
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
  # The claim can't know the ticket's model and effort beforehand, so a ticket that sets them is handed to that worker
  # now.
  use_worker "$(jq -r '.agentModel // ""' <<<"$ticket")" "$(jq -r '.agentEffort // ""' <<<"$ticket")"
  adopt "$id" "$(jq -r .number <<<"$ticket")" "$WORKER" "$(jq -r .version <<<"$ticket")" || use_worker "" ""
  # Everything on the ticket so far is handed to this run. Until it succeeds, the claim itself counts as feedback,
  # so a failed or interrupted run is retried with backoff.
  snapshot=$(get "/tickets/$id/activity" | jq -c '{activity: (map(.id) | max // 0)}') || snapshot='{}'
  write_state "$id" "$(jq -c '. + {claim: true}' <<<"$snapshot")"
  claim_unlock
  run_on_ticket "$id" "$(intro)

Ticket $id is already claimed for you and in progress. Work only this ticket; do not claim another.
Take it through to review and exit after submitting it. If it is tagged question, submit it for review with the answer \
as the comment and no pull request." "$snapshot" "claim"
  unlock_ticket
  return 0
}

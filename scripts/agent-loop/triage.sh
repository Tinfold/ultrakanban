# The jq programs that find a ticket's new feedback (TRIAGE) and the columns the agent doesn't work in.
# Part of agent-loop.sh, which sources it; the settings it uses are described there.

# Finds a ticket's new feedback. Input: its activity, open pull request (gh pr view) or null, the classified checks
# of its head commit (ci_status) or null, pull request comments, reviews and inline comments (GitHub REST), and its
# saved state. Prints the snapshot to save after a successful run, the items to hand over, their fingerprint,
# whether to run now (backoff after failures), and which notes to leave (CI not running, CI run cap reached).
read -r -d '' TRIAGE <<'JQ'
def bot: (.user.type // "") == "Bot" or ((.user.login // "") | endswith("[bot]"));
def feedback: (bot | not) and ((.body // "") | contains($marker) | not);
def ours: . == $agent or . == $loop or startswith($agent + "/");
def clip: if length > 2000 then .[:2000] + " [...]" else . end;
. as [$activity, $pr, $ci, $issue, $reviews, $inline, $s]
| ($pr // {}) as $p
| ($s.checks | if type == "object" then . else {} end) as $seen
| (if $ci != null and $seen.sha == $ci.sha then $seen.names // [] else [] end) as $handedOver
| (($ci.code // []) - $handedOver) as $newFailures
| (if $p.mergeable == "CONFLICTING" or $p.mergeStateStatus == "DIRTY" then "\($p.headRefOid):\($p.baseRefOid)"
   else "" end) as $conflict
| [ ($activity[] | select(.type == "comment" and .id > ($s.activity // 0) and (.actor | ours | not))
      | {key: "t\(.id)", text: "Ticket comment from \(.actor):\n\(.data.body // "" | clip)"}),
    ($activity[] | select(.type == "moved" and .id > ($s.activity // 0) and (.actor | ours | not))
      | select((.data.to // "" | ascii_downcase) == ($working | ascii_downcase))
      | {key: "t\(.id)", text: ("\(.actor) moved the ticket from \(.data.from) to \(.data.to):\n"
         + "They want more work on it. Look for what in their comments on the ticket and the pull request. If they "
         + "don't say, ask them in a ticket comment and leave the ticket in \(.data.to).")}),
    ($issue[] | select(.id > ($s.issue // 0) and feedback)
      | {key: "i\(.id)", text: "Pull request comment from \(.user.login) (\(.html_url)):\n\(.body // "" | clip)"}),
    ($reviews[] | select(.id > ($s.review // 0) and feedback and .state != "PENDING")
      | select(.state != "COMMENTED" or (.body // "") != "")
      | {key: "r\(.id)",
         text: "Pull request review (\(.state)) from \(.user.login) (\(.html_url)):\n\(.body // "" | clip)"}),
    ($inline[] | select(.id > ($s.inline // 0) and feedback)
      | {key: "c\(.id)", text: ("Inline review comment from \(.user.login) "
         + "on \(.path):\(.line // .original_line // "?") (\(.html_url)):\n\(.body // "" | clip)")})
  ] as $human
| [ if $newFailures != [] then
      {key: "checks \($ci.sha):\($newFailures | join(","))",
       text: "Failing checks on \($ci.sha[:7]): \($newFailures | join(", "))"}
    else empty end ] as $ciItems
| (($s.ciRuns // 0) >= $maxci and $human == [] and $ciItems != []) as $capped
| (if $capped then [] else $ciItems end) as $ciUsed
| (if $human != [] then 0 elif $ciUsed != [] then ($s.ciRuns // 0) + 1 else ($s.ciRuns // 0) end) as $ciRuns
| ($ci != null and $ci.infra != [] and $s.infraNoted != $ci.sha) as $infraNote
| ($capped and ($s.capNoted | not)) as $capNote
| {
    snapshot: ({
      activity: ([$activity[].id, $s.activity // 0] | max),
      issue: ([$issue[].id, $s.issue // 0] | max),
      review: ([$reviews[].id, $s.review // 0] | max),
      inline: ([$inline[].id, $s.inline // 0] | max),
      checks: (if $ci == null or $capped then $seen else {sha: $ci.sha, names: ($handedOver + $ci.code | unique)} end),
      conflict: $conflict,
      ciRuns: $ciRuns,
      infraNoted: (if $infraNote then $ci.sha else $s.infraNoted end),
      capNoted: (if $ciRuns != 0 and ($capNote or $s.capNoted == true) then true else null end)
    } | with_entries(select(.value != null))),
    items: ([
      (if $s.claim then {key: "claim", text: ("The previous run on this ticket didn't finish. "
        + "Check what it got done and carry on from there.")} else empty end),
      $human[], $ciUsed[],
      (if $conflict != "" and $conflict != ($s.conflict // "") then
        {key: "conflict \($conflict)", text: "The pull request has merge conflicts with \($p.baseRefName)"}
       else empty end)
    ]),
    ci: ($ciUsed != []),
    ciRuns: $ciRuns,
    infraNote: (if $infraNote then $ci else null end),
    capNote: $capNote
  }
| .fingerprint = (.items | map(.key) | join(" "))
| .run = (.items != [] and (($s.failedFor // null) != .fingerprint or (($s.failures // 0) < $max
    and $now >= ($s.failedAt // 0) + $retry * pow(2; ($s.failures // 1) - 1))))
JQ

# The columns of a board (GET /boards/:id) in which the agent doesn't work tickets, as {id: {name, queued}}: the todo
# column and the columns before it, where tickets wait to be worked (queued), and the done and cancelled columns.
read -r -d '' IDLE_COLUMNS <<'JQ'
def named($name): [.columns[] | select((.name | ascii_downcase) == ($name | ascii_downcase))][0];
(.board.doneColumnId // "") as $done
| (.board.reviewColumnId // "") as $review
| (named($cancelled).id // "") as $cancelledId
| (named($working).id // "") as $workingId
| (named($todo).position // -1) as $todoAt
| [.columns[] | (.id == $done or .id == $cancelledId) as $closed
    | select($closed or (.position <= $todoAt and .id != $review and .id != $workingId))
    | {key: .id, value: {name, queued: ($closed | not)}}]
| from_entries
JQ

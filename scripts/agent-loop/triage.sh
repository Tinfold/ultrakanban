# The jq programs that find a ticket's new feedback (TRIAGE) and the columns the agent doesn't work in.
# Part of agent-loop.sh, which sources it; the settings it uses are described there.

# Finds a ticket's new feedback. Input: its activity, open pull request (gh pr view) or null, the classified checks
# of its head commit (ci_status) or null, pull request comments, reviews and inline comments (GitHub REST), and its
# saved state. Prints the snapshot to save after a successful run, the items to hand over, their fingerprint,
# whether to run now (backoff after failures), whether there is human feedback among them, whether the pull request
# has merge conflicts now, and which notes to leave (CI not running, CI run cap or conflict run cap reached).
#
# The board wakes the loop up for the same ticket activity this counts as human feedback (comments, moves into the
# in-progress column and approved plans by anyone but the agent; see wakeForFeedback in server/store/tickets.ts), so
# keep the two in step.
#
# After a person stopped a run on the ticket (the state's `stopped`, that run's snapshot), it doesn't run again until
# there is human feedback that run wasn't handed: a comment, a move or an approval on the ticket, or pull request
# feedback, newer than the snapshot. Then it hands over everything new as usual, that feedback included.
#
# The agent posts on GitHub from the same account as the people reviewing it, so a pull request comment, review or
# inline comment it posted without the marker would look like feedback and start its next run. So pull request feedback
# created while one of the agent's runs was going on the ticket (the state's `runs`, [start, end] in epoch seconds, kept
# by run_on_ticket) doesn't count: what a person writes on the pull request meanwhile is skipped too, but the run that
# was going may well have seen it, and ticket comments, which carry their actor, still count.
read -r -d '' TRIAGE <<'JQ'
def bot: (.user.type // "") == "Bot" or ((.user.login // "") | endswith("[bot]"));
def feedback: (bot | not) and ((.body // "") | contains($marker) | not);
# A short acknowledgement ("thanks", "LGTM", a lone emoji) asks for nothing, so it doesn't start a run. One without
# words is all punctuation and symbols (emoji, with the marks and joiners they are made of): a short comment in another
# script, such as "Исправь опечатку", is feedback.
def ack: (.body // "") | gsub("^[\\s[:punct:]]+|[\\s[:punct:]]+$"; "") | ascii_downcase
  | (length <= 40) and (test("^([\\s\\p{P}\\p{S}\\p{M}\\p{Cf}]*|(thanks?|thank you|thx|ty|lgtm|looks good( to me)?|nice|great|perfect|awesome|cool|ok(ay)?|done|"
    + "good|approved?|\\+1|ship it|merged?|sounds good|great work|good job|nice work)( (you|so much|a lot|everyone|all))?)$"));
def ours: . == $agent or . == $loop or startswith($agent + "/");
# Whether a pull request comment or review was created during one of the given runs ([start, end] in epoch seconds).
def during($runs): ((.submitted_at // .created_at // "") | try (sub("\\.[0-9]+"; "") | fromdateiso8601) catch null) as $at
  | $at != null and any($runs[]; .[0] <= $at and $at <= .[1]);
def clip: if length > 2000 then .[:2000] + " [...]" else . end;
. as [$activity, $pr, $ci, $issue, $reviews, $inline, $s]
| ($s.runs | if type == "array" then . else [] end) as $runs
| ($pr // {}) as $p
| ($s.checks | if type == "object" then . else {} end) as $seen
| (if $ci != null and $seen.sha == $ci.sha then $seen.names // [] else [] end) as $handedOver
| (($ci.code // []) - $handedOver) as $newFailures
| (if $p.mergeable == "CONFLICTING" or $p.mergeStateStatus == "DIRTY" then "\($p.headRefOid):\($p.baseRefOid)"
   else "" end) as $conflict
# The human feedback above the given watermarks (a snapshot's activity, issue, review and inline ids).
| def human($w): [
    ($activity[] | select(.type == "comment" and .id > ($w.activity // 0) and (.actor | ours | not))
      | select(.data | ack | not)
      | {key: "t\(.id)", text: "Ticket comment from \(.actor):\n\(.data.body // "" | clip)"}),
    ($activity[] | select(.type == "moved" and .id > ($w.activity // 0) and (.actor | ours | not))
      | select((.data.to // "" | ascii_downcase) == ($working | ascii_downcase))
      | {key: "t\(.id)", text: ("\(.actor) moved the ticket from \(.data.from) to \(.data.to):\n"
         + "They want more work on it. Look for what in their comments on the ticket and the pull request. If they "
         + "don't say, ask them in a ticket comment and leave the ticket in \(.data.to).")}),
    ($activity[] | select(.type == "approved" and .id > ($w.activity // 0) and (.actor | ours | not))
      | {key: "t\(.id)", text: ("\(.actor) approved your plan:\n"
         + "Go on with the work you planned, and take the ticket through to review.")}),
    ($issue[] | select(.id > ($w.issue // 0) and feedback and (ack | not) and (during($runs) | not))
      | {key: "i\(.id)", text: "Pull request comment from \(.user.login) (\(.html_url)):\n\(.body // "" | clip)"}),
    ($reviews[] | select(.id > ($w.review // 0) and feedback and .state != "PENDING" and (during($runs) | not))
      | select((.body // "") != "" and (ack | not))
      | {key: "r\(.id)",
         text: "Pull request review (\(.state)) from \(.user.login) (\(.html_url)):\n\(.body // "" | clip)"}),
    ($inline[] | select(.id > ($w.inline // 0) and feedback and (ack | not) and (during($runs) | not))
      | {key: "c\(.id)", text: ("Inline review comment from \(.user.login) "
         + "on \(.path):\(.line // .original_line // "?") (\(.html_url)):\n\(.body // "" | clip)")})
  ];
human($s) as $human
| ($s.stopped | if type == "object" then human(.) != [] else true end) as $resumable
| [ if $newFailures != [] then
      {key: "checks \($ci.sha):\($newFailures | join(","))",
       text: "Failing checks on \($ci.sha[:7]): \($newFailures | join(", "))"}
    else empty end ] as $ciItems
| (($s.ciRuns // 0) >= $maxci and $human == [] and $ciItems != []) as $capped
| (if $capped then [] else $ciItems end) as $ciUsed
| (if $human != [] then 0 elif $ciUsed != [] then ($s.ciRuns // 0) + 1 else ($s.ciRuns // 0) end) as $ciRuns
| ($conflict != "" and $conflict != ($s.conflict // "")) as $newConflict
| ($newConflict and ($s.conflictRuns // 0) >= $maxconflict and $human == []) as $conflictCapped
| (if $human != [] then 0 elif $newConflict and ($conflictCapped | not) then ($s.conflictRuns // 0) + 1
   else ($s.conflictRuns // 0) end) as $conflictRuns
| ($ci != null and $ci.infra != [] and $s.infraNoted != $ci.sha) as $infraNote
| ($capped and ($s.capNoted | not)) as $capNote
| ($conflictCapped and ($s.conflictCapNoted | not)) as $conflictCapNote
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
      capNoted: (if $ciRuns != 0 and ($capNote or $s.capNoted == true) then true else null end),
      conflictRuns: $conflictRuns,
      conflictCapNoted: (if $conflictRuns != 0 and ($conflictCapNote or $s.conflictCapNoted == true) then true else null end),
      runs: (if $runs == [] then null else $runs end)
    } | with_entries(select(.value != null))),
    items: ([
      (if $s.claim then {key: "claim", text: ("The previous run on this ticket didn't finish. "
        + "Check what it got done and carry on from there.")} else empty end),
      $human[], $ciUsed[],
      (if $newConflict and ($conflictCapped | not) then
        {key: "conflict \($conflict)", text: "The pull request has merge conflicts with \($p.baseRefName)"}
       else empty end)
    ]),
    human: ($human != []),
    ci: ($ciUsed != []),
    conflicted: ($conflict != ""),
    ciRuns: $ciRuns,
    infraNote: (if $infraNote then $ci else null end),
    capNote: $capNote,
    conflictCapNote: $conflictCapNote
  }
| .fingerprint = (.items | map(.key) | join(" "))
| .run = ($resumable and .items != [] and (($s.failedFor // null) != .fingerprint or (($s.failures // 0) < $max
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

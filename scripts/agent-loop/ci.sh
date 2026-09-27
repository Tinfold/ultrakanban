# Classifying a commit's failing checks as the code's fault or CI's.
# Part of agent-loop.sh, which sources it; the settings it uses are described there.

# Classifies the checks on a commit that didn't pass. Only checks that ran and failed are "code" failures, which
# count as feedback. "infra" ones never start a run: startup_failure, action_required, timed_out (usually a hung
# runner, and retrying it tends to loop), failures whose output or annotations mention billing, spending limits or a
# job that was not started, and GitHub Actions jobs in which no step failed (e.g. no step ran at all). Cancelled,
# skipped, neutral and stale checks are ignored. Legacy commit statuses count as code failures for "failure" and as
# infra for "error". Prints {sha, code: [names], infra: [{name, why}]}.
ci_status() {
  local repo=$1 sha=$2 runs statuses id name conclusion app count text why job
  runs=$(gh api --paginate "repos/$repo/commits/$sha/check-runs?filter=latest&per_page=100" </dev/null |
    jq -rs '[.[].check_runs[]] | group_by(.name) | map(max_by(.id))[]
      | select(.status == "completed")
      | select(.conclusion | IN("failure", "timed_out", "startup_failure", "action_required"))
      | [.id, .name, .conclusion, .app.slug // "", .output.annotations_count // 0,
         ([.output.title, .output.summary, .output.text] | map(select(.)) | join(" ") | gsub("[\t\n\r]"; " "))]
      | @tsv') || return 1
  statuses=$(gh api "repos/$repo/commits/$sha/status" </dev/null |
    jq -r '.statuses[]? | select(.state == "failure" or .state == "error")
      | [.context, .state, (.description // "" | gsub("[\t\n\r]"; " "))] | @tsv') || return 1
  {
    while IFS=$'\t' read -r -u 4 id name conclusion app count text; do
      [[ -n $id ]] || continue
      why=
      if [[ $conclusion != failure ]]; then
        why=$conclusion
      else
        if [[ $count != 0 ]]; then
          text+=" $(gh api "repos/$repo/check-runs/$id/annotations" </dev/null | jq -r '[.[].message] | join(" ")')"
        fi
        if grep -qiE "$INFRA_PATTERN" <<<"$text"; then
          why=$(grep -oiE "[^.]*($INFRA_PATTERN)[^.]*" <<<"$text" | head -1)
        elif [[ $app == github-actions ]] && job=$(gh api "repos/$repo/actions/jobs/$id" </dev/null) &&
          ! jq -e 'any(.steps[]?; .conclusion == "failure")' >/dev/null <<<"$job"; then
          why="no step ran and failed"
        fi
      fi
      if [[ -n $why ]]; then printf 'infra\t%s\t%s\n' "$name" "$why"; else printf 'code\t%s\n' "$name"; fi
    done 4<<<"$runs"
    while IFS=$'\t' read -r -u 4 name conclusion text; do
      [[ -n $name ]] || continue
      if [[ $conclusion == error ]] || grep -qiE "$INFRA_PATTERN" <<<"$text"; then
        printf 'infra\t%s\t%s\n' "$name" "status $conclusion: $text"
      else
        printf 'code\t%s\n' "$name"
      fi
    done 4<<<"$statuses"
  } | jq -Rn --arg sha "$sha" '[inputs | split("\t")]
    | {sha: $sha, code: ([.[] | select(.[0] == "code") | .[1]] | unique),
       infra: [.[] | select(.[0] == "infra") | {name: .[1], why: (.[2] | gsub("^\\s+|\\s+$"; ""))}]}'
}

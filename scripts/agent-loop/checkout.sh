# Checkouts in a dedicated clone, and keeping the work of runs that didn't finish.
# Part of agent-loop.sh, which sources it; the settings it uses are described there.

# In a dedicated clone, a run that doesn't finish (it failed, timed out, ran out of Claude usage, or the loop or the
# machine stopped) leaves its work in the checkout, and the next checkout would discard it. So each run records its
# ticket and starting commit in the checkout's git directory (RUN_FILE), and a successful run removes that record.
# While the record is there, the checkout's work belongs to that ticket, and save_work keeps it before anything is
# discarded: its local commits and all its changes, untracked files included, as one commit on top of them, under
# refs/ultrakanban/work/<ticket> (shared by the clone and its worktrees). The commit message names the branch it was on.
run_file() { printf '%s/ultrakanban-run' "$(git rev-parse --git-dir)"; }

save_work() {
  local file id base branch tree commit
  file=$(run_file) || return 1
  [[ -f $file ]] || return 0
  read -r id base <"$file"
  if [[ -n $id ]]; then
    branch=$(git branch --show-current)
    git add -A >/dev/null 2>&1
    if tree=$(git write-tree) && [[ $tree != $(git rev-parse 'HEAD^{tree}') || $(git rev-parse HEAD) != "$base" ]]; then
      commit=$(git commit-tree "$tree" -p HEAD -m "Unfinished work on ticket $id

branch: ${branch:--}") && git update-ref "refs/ultrakanban/work/$id" "$commit" ||
        { log "error: can't keep the unfinished work on $id; it is discarded"; rm -f "$file"; return 0; }
      log "kept the unfinished work on $id (${branch:-detached HEAD}) as refs/ultrakanban/work/$id"
    fi
  fi
  rm -f "$file"
}

# Puts back a ticket's unfinished work saved by save_work: its branch (or a detached HEAD) with its local commits, and
# its changes uncommitted in the working tree. Prints where it is.
restore_work() {
  local ref=refs/ultrakanban/work/$1 branch
  git rev-parse --verify --quiet "$ref" >/dev/null || return 1
  branch=$(git log -1 --format=%B "$ref" | sed -n 's/^branch: //p')
  if [[ -n $branch && $branch != - ]]; then
    git checkout --quiet --ignore-other-worktrees -B "$branch" "$ref" || return 1
  else
    git checkout --quiet --detach "$ref" || return 1
    branch=
  fi
  git reset --quiet 'HEAD~1' || return 1
  git update-ref -d "$ref"
  printf '%s at %s\n' "${branch:+branch }${branch:-a detached HEAD}" "$(git rev-parse --short HEAD)"
}

# In a dedicated clone or worktree (AGENT_LOOP_CLEAN=1, set by agent-board.sh), puts the checkout on an up-to-date
# branch: the given one (a pull request's branch) if it exists on origin, otherwise the default branch, detached so
# that other worktrees can have it too. Local changes are discarded (after save_work keeps those of an unfinished run),
# so this never happens in a normal working copy. Fetches hold a lock in the repository, so loops in worktrees of one
# clone don't fetch at once. Prints the branch.
checkout() {
  local branch=$1 default lock
  if [[ ${AGENT_LOOP_CLEAN:-0} != 1 ]]; then
    git branch --show-current 2>/dev/null
    return 0
  fi
  save_work
  lock=$(git rev-parse --git-common-dir)/ultrakanban-fetch.lock || return 1
  flock "$lock" git fetch --prune --quiet origin || return 1
  default=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) ||
    { flock "$lock" git remote set-head origin --auto >/dev/null &&
      default=$(git symbolic-ref --short refs/remotes/origin/HEAD); } ||
    return 1
  default=${default#origin/}
  [[ -n $branch ]] && git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null || branch=$default
  git rebase --abort >/dev/null 2>&1
  git merge --abort >/dev/null 2>&1
  git reset --quiet --hard && git clean -fdq || return 1
  clear_build_output
  if [[ $branch == "$default" ]]; then
    git checkout --quiet --detach "origin/$branch" || return 1
  else
    git checkout --quiet --ignore-other-worktrees -B "$branch" "origin/$branch" || return 1
  fi
  printf '%s\n' "$branch"
}

# Build output (ignored files such as target/ or node_modules/) is kept between runs so builds stay incremental, but it
# grows with every ticket: a Rust target/ reaches hundreds of GB. Once the checkout's ignored files take more than
# MAX_BUILD_GB, they are all removed, except the ultrakanban skill agent-board.sh puts there. Cargo hardlinks its
# output, so du counts each file once.
clear_build_output() {
  local kb
  [[ $MAX_BUILD_GB =~ ^[1-9][0-9]*$ ]] || return 0
  kb=$(git ls-files -z --others --ignored --exclude-standard --directory | xargs -0 -r du -sck | tail -1 | cut -f1)
  ((${kb:-0} > MAX_BUILD_GB * 1024 * 1024)) || return 0
  log "build output takes $((kb / 1024 / 1024)) GB, over MAX_BUILD_GB=$MAX_BUILD_GB: clearing it" >&2
  git clean -fdXq -e '!/.claude/skills/ultrakanban/SKILL.md'
}

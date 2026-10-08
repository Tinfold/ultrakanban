#!/usr/bin/env bash
# Starts the agents container (deploy/agents.Dockerfile): sets git up to push with gh's GitHub login (GH_TOKEN, or
# `gh auth login` in the container, which the board's Setup page runs) and to commit as that GitHub user, then runs the
# agent supervisor.

set -uo pipefail

if gh auth status >/dev/null 2>&1; then
  gh auth setup-git
  if [[ -z $(git config --global user.name) ]]; then
    git config --global user.name "$(gh api user --jq '.name // .login')"
    git config --global user.email "$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
  fi
else
  echo "gh is not logged in: log the agents in to GitHub on the board's Setup page (/setup)"
fi
if [[ ! -f $HOME/.claude/.credentials.json && -z ${CLAUDE_CODE_OAUTH_TOKEN:-} ]]; then
  echo "claude is not logged in: log the agents in to Claude on the board's Setup page (/setup)"
fi

exec /opt/ultrakanban-agent/bin/agent-supervisor.sh

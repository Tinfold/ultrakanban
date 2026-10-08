# The agents in a container: the agent supervisor and its loops, with what they and claude's runs need (claude, git, gh,
# jq, Node.js, Python and a C toolchain for builds and tests). It runs on Windows and macOS through Docker Desktop, and
# on Linux without systemd. Started with: docker compose --profile agents up -d (see docs/agents.md).
FROM node:22-bookworm

RUN mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
    >/etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh jq ripgrep util-linux uuid-runtime procps less \
    build-essential python3 python3-venv python3-pip tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code && npm cache clean --force

COPY scripts/agent-loop.sh scripts/agent-board.sh scripts/agent-supervisor.sh /opt/ultrakanban-agent/bin/
COPY scripts/agent-loop/ /opt/ultrakanban-agent/bin/agent-loop/
COPY .claude/skills/ultrakanban/SKILL.md /opt/ultrakanban-agent/skill/
COPY deploy/agents-entrypoint.sh /opt/ultrakanban-agent/
RUN chmod 755 /opt/ultrakanban-agent/bin/*.sh /opt/ultrakanban-agent/agents-entrypoint.sh

# The node user's home is a volume: claude's login and sessions, gh's login and the boards' clones live there.
USER node
ENV HOME=/home/node NO_SYSTEMD=1 KANBAN=http://app:4317
WORKDIR /home/node
ENTRYPOINT ["tini", "--", "/opt/ultrakanban-agent/agents-entrypoint.sh"]

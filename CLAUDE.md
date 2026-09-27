# ultrakanban

Kanban board with an HTTP API for coding agents. Hono + SQLite server, React + Vite UI, bash agent loop.

## Where things are

- `shared/domain.ts` types and constants (agent defaults), `shared/schemas.ts` request validation (zod)
- `server/routes/*.ts` API routes, `server/store/*.ts` database queries, `server/db.ts` schema and migrations
  (append new ones at the end)
- `server/*.test.ts` API tests by area (tickets, pull requests, overview, merge queue, attachments), all built on
  `server/test-app.ts` (the app with a fake GitHub)
- `src/pages`, `src/components/<area>`, `src/lib` UI; `src/components/ui` are shadcn components
- `scripts/agent-loop.sh` the agent loop's settings and main loop; the rest of it is in `scripts/agent-loop/`
  (`triage` jq, `board` helpers, `ci`, `checkout`, `run` for claude runs and the prompt, `tickets` for claiming and
  feedback). `agent-board.sh` and `agent-supervisor.sh` run the loops as services.
- `docs/API.md` API reference (34 KB: grep for the section you need), `README.md` setup and agent loop docs
- `.claude/skills/ultrakanban/SKILL.md` the skill agents follow

## Checks

`npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`; `bash -n` for scripts.

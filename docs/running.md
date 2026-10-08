# Running the board

## Running with Docker

```sh
cp .env.example .env          # optional: set GITHUB_TOKEN (gh auth token), or add one on the Setup page
docker compose up -d --build  # http://localhost:4317
```

nginx serves the app on `ULTRAKANBAN_PORT` (4317 by default) and both containers restart automatically,
including after a reboot. The database and attachments live in the `ultrakanban-data` volume.

```sh
docker compose logs -f app                            # logs
docker compose cp app:/app/data ./backup             # back up the database and attachments
docker compose down && docker compose up -d --build  # update after pulling changes

# Move an existing local board into the container
docker compose stop app
docker compose cp ./data/ultrakanban.db app:/app/data/
docker compose cp ./data/attachments app:/app/data/
docker compose start app
```

There is no authentication, so only publish it on a network you trust. To put it on the internet, terminate
TLS in front of nginx (or add a `listen 443 ssl` server block with your certificates in `deploy/nginx.conf`).

## Without Docker

For development, or to run it without Docker. Requires Node.js 22.13+.

```sh
npm install
npm run dev          # http://localhost:5173 (API on :4317)
```

Production:

```sh
npm run build
npm start            # http://127.0.0.1:4317 serves the app and the API
```

| Variable                  | Default               | Purpose                                                                                                                                                       |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `4317`                | API / app port                                                                                                                                                |
| `HOST`                    | `127.0.0.1`           | Bind address. Use `0.0.0.0` to reach it from your phone on LAN                                                                                                |
| `ULTRAKANBAN_DB`          | `data/ultrakanban.db` | SQLite database file (`:memory:` for throwaway)                                                                                                               |
| `ULTRAKANBAN_ATTACHMENTS` | next to the database  | Directory for uploaded attachment files                                                                                                                       |
| `GITHUB_TOKEN`            | `gh auth token`       | Token for checking pull requests (private repos need `repo` read access) and creating repositories (`repo` scope). One set on the Setup page takes precedence |
| `GITHUB_SYNC_INTERVAL`    | `60`                  | Seconds between pull request checks                                                                                                                           |
| `ULTRAKANBAN_URL`         |                       | Address people open the app at, e.g. `http://kanban.lan:4317`; notifications link to the ticket there                                                         |

There is no authentication: only expose it on networks you trust.

## Development

```sh
npm test             # API integration tests (node:test)
npm run typecheck
npm run lint
npm run format
```

```
shared/          domain types and zod request schemas used by both sides
server/
  db.ts          SQLite connection, migrations, transactions (publishes change events after commit)
  store/         data access and domain operations (no HTTP)
  routes/        Hono routes: validate input, run store operations in a transaction
src/
  lib/           API client, pure view logic (filter/sort), optimistic cache updates
  hooks/         React Query hooks, board actions, live updates, persisted state
  components/
    board/       canvas, columns, cards, drag and drop, toolbar
    ticket/      ticket dialog, rich text editor, pickers, activity
    boards/      board switcher, settings, tags, import/export, agent API
    ui/          shadcn/ui primitives
```

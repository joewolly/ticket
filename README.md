# Homelab Tickets

A small self-hosted ticket system and device inventory for a personal homelab.
Track what's broken, which machine it's broken on, and what you did about it.

Runs as a single container with a SQLite file. **No npm dependencies** — the
whole thing is Node's standard library, so there is nothing to install, nothing
to build, and no supply chain to keep an eye on.

## Quick start

```sh
docker compose up -d
```

Then open <http://localhost:8080>.

To run it directly instead:

```sh
npm start          # http://localhost:8080, database at ./data/homelab.db
npm run dev        # same, with auto-restart on file changes
npm test           # 34 tests, no network or fixtures needed
```

Node 22.5+ is required (for the built-in `node:sqlite` module).

## What it does

**Tickets** carry a status (`open`, `in_progress`, `blocked`, `resolved`,
`closed`), a priority, optional tags, an optional due date, and a comment
thread for notes as you work the problem. The default list view shows only
what still needs attention, sorted most urgent first.

**Devices** are the things you own — servers, NAS, switches, VMs, Pis. Each
device shows its open tickets and its full service history, so "what have I
done to this box before?" stays answerable. Deleting a device keeps its
tickets and just unlinks them; the history of a machine you no longer own is
usually the part worth keeping.

**The dashboard** surfaces open counts by priority, which devices have the most
unresolved work, anything overdue, and anything open that hasn't been touched
in two weeks — the tickets you forgot rather than finished.

## Configuration

| Variable  | Default             | Purpose                                    |
| --------- | ------------------- | ------------------------------------------ |
| `PORT`    | `8080`              | Port to listen on                          |
| `HOST`    | `0.0.0.0`           | Bind address                               |
| `DB_PATH` | `./data/homelab.db` | SQLite file (`/data/homelab.db` in Docker) |
| `TZ`      | `UTC`               | Container timezone                         |

There is **no authentication**. This is built to sit on a trusted LAN. Don't
expose it to the internet without putting an authenticating reverse proxy
(Authelia, Tailscale, Cloudflare Access, basic auth) in front of it.

## Backups

Everything is in the one SQLite file. To snapshot it safely while the app is
running, use SQLite's online backup rather than copying the file:

```sh
docker compose exec ticket \
  node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/homelab.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp ticket:/data/backup.db ./homelab-backup.db
```

## API

The UI is a client of the same JSON API, so scripts and cron jobs can file
tickets too — useful for having a monitoring script open a ticket on failure.

| Method   | Path                             | Purpose                     |
| -------- | -------------------------------- | --------------------------- |
| `GET`    | `/api/stats`                     | Dashboard summary           |
| `GET`    | `/api/tickets`                   | List / filter tickets       |
| `POST`   | `/api/tickets`                   | Create a ticket             |
| `GET`    | `/api/tickets/:id`               | One ticket, with comments   |
| `PATCH`  | `/api/tickets/:id`               | Update any subset of fields |
| `DELETE` | `/api/tickets/:id`               | Delete a ticket             |
| `POST`   | `/api/tickets/:id/comments`      | Add a note                  |
| `DELETE` | `/api/tickets/:id/comments/:cid` | Delete a note               |
| `GET`    | `/api/devices`                   | List / filter devices       |
| `POST`   | `/api/devices`                   | Register a device           |
| `GET`    | `/api/devices/:id`               | One device                  |
| `PATCH`  | `/api/devices/:id`               | Update any subset of fields |
| `DELETE` | `/api/devices/:id`               | Delete a device             |
| `GET`    | `/api/tags`                      | Tags in use, with counts    |
| `GET`    | `/api/health`                    | Health check                |

Ticket list filters: `status` (a specific status, or `all`; defaults to
everything unresolved), `priority`, `device_id`, `tag`, `q` (text search), and
`sort` (`priority`, `newest`, `oldest`, `updated`, `due`).

Filing a ticket from a script:

```sh
curl -X POST http://localhost:8080/api/tickets \
  -H 'Content-Type: application/json' \
  -d '{"title":"Backup job failed","priority":"high","device_id":1,"tags":["backup"]}'
```

## Layout

```
src/
  server.js      HTTP server, routing, error mapping
  db.js          Schema, versioned migrations, transaction helper
  validate.js    Input validation and the domain enums
  static.js      Static file serving for the frontend
  api/           devices.js, tickets.js, stats.js — the data layer
public/          index.html, app.js, styles.css — dependency-free SPA
test/            Unit tests per module plus HTTP integration tests
```

Schema changes go in the `MIGRATIONS` array in `src/db.js` — append a new
entry, never edit an existing one, and it will apply itself on next start.

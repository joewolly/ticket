# Homelab Tickets

A small self-hosted ticket system and device inventory for a personal homelab.
Track what's broken, which machine it's broken on, and what you did about it.

Runs as a single container with a SQLite file. **No npm dependencies** — the
whole thing is Node's standard library, so there is nothing to install, nothing
to build, and no supply chain to keep an eye on.

## Quick start

```sh
cp .env.example .env    # then set AUTH_PASSWORD
docker compose up -d
```

Then open <http://localhost:8080> and sign in.

To run it directly instead:

```sh
AUTH_PASSWORD=your-long-passphrase npm start   # http://localhost:8080
npm run dev                                    # same, with auto-restart
npm test                                       # 68 tests, no network needed
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

## Authentication

One password protects the whole instance — it's a single-user tool, so there
are no accounts to manage. Set `AUTH_PASSWORD` and sign in at `/login`; the
session is a random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie,
stored server-side as a SHA-256 hash so a leaked database file yields no
usable sessions. Repeated failures from one address lock login out for 15
minutes.

**The app refuses to start without a password.** If something else already
authenticates your traffic — Authelia, Tailscale, Cloudflare Access — opt out
deliberately:

```sh
AUTH_DISABLED=true
```

Setting both is an error rather than a silent precedence rule.

Scripts and cron jobs can't hold a cookie, so set `API_TOKEN` for them and
pass it as a bearer token:

```sh
curl -X POST http://localhost:8080/api/tickets \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Backup job failed","priority":"high","device_id":1}'
```

Two caveats worth knowing. Serving over plain HTTP means the password crosses
your LAN in the clear — fine against the casual case this is built for, not
against someone already on your network; put it behind HTTPS if that matters,
and set `COOKIE_SECURE=true` when you do. And the password lives in an
environment variable, so anyone who can read your `.env` or run `docker
inspect` can read it.

## Configuration

| Variable        | Default             | Purpose                                       |
| --------------- | ------------------- | --------------------------------------------- |
| `AUTH_PASSWORD` | *(required)*        | Sign-in password, minimum 8 characters        |
| `AUTH_DISABLED` | unset               | Deliberately run with no authentication       |
| `API_TOKEN`     | unset               | Bearer token for scripts, minimum 16 chars    |
| `SESSION_DAYS`  | `30`                | Session lifetime before re-authenticating     |
| `COOKIE_SECURE` | `false`             | Add `Secure` to the cookie — set when on HTTPS |
| `PORT`          | `8080`              | Port to listen on                             |
| `HOST`          | `0.0.0.0`           | Bind address                                  |
| `DB_PATH`       | `./data/homelab.db` | SQLite file (`/data/homelab.db` in Docker)    |
| `TZ`            | `UTC`               | Container timezone                            |

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
| `POST`   | `/api/auth/login`                | Exchange the password for a session |
| `POST`   | `/api/auth/logout`               | End this session (`{"everywhere":true}` ends all) |
| `GET`    | `/api/auth/session`              | Whether auth is on          |
| `GET`    | `/api/health`                    | Health check                |

Every endpoint except `/api/auth/login` requires either a session cookie or an
API token; unauthenticated API calls get a `401`, and page requests redirect to
`/login`.

Ticket list filters: `status` (a specific status, or `all`; defaults to
everything unresolved), `priority`, `device_id`, `tag`, `q` (text search), and
`sort` (`priority`, `newest`, `oldest`, `updated`, `due`).

## Layout

```
src/
  server.js      HTTP server, routing, the auth gate, error mapping
  auth.js        Config, sessions, login throttling, cookies, API tokens
  db.js          Schema, versioned migrations, transaction helper
  validate.js    Input validation and the domain enums
  static.js      Static file serving for the frontend
  api/           devices.js, tickets.js, stats.js — the data layer
public/          index.html, app.js, login.html, styles.css — dependency-free SPA
test/            Unit tests per module plus HTTP integration tests
```

Schema changes go in the `MIGRATIONS` array in `src/db.js` — append a new
entry, never edit an existing one, and it will apply itself on next start.

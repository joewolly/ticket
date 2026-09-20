# Task Hub

A self-hosted inbox for issues, chores, ideas, and things you want to get done.
Capture a thought now; decide what to do with it later. Device inventory and
recurring maintenance remain available alongside everyday personal tasks.

Runs as a single container with a SQLite file. **No npm dependencies** — the
whole thing is Node's standard library, so there is nothing to install, nothing
to build, and no supply chain to keep an eye on.

## Quick start

```sh
cp .env.example .env    # then set AUTH_PASSWORD
docker compose up -d
```

Then open <http://localhost:8080> and sign in.

Compose binds to the Docker host's loopback address, enables daily backups on
a separate volume, and retains 14 snapshots. For private phone access through
Tailscale and the production upgrade/restore procedure, see
[Daily-use deployment](docs/deployment.md). On a remote Docker host, localhost
means that host, not your computer.

To run it directly instead:

```sh
AUTH_PASSWORD=your-long-passphrase npm start   # http://localhost:8080
npm run dev                                    # same, with auto-restart
npm test                                       # unit and integration tests, no network needed
```

Node 22.16+ is required — for the built-in `node:sqlite` module, and
specifically for the FTS5 full-text search the ticket index relies on.

## What it does

The home screen is **Inbox**. Press **Add task** (or `n`), enter a title, and
save. Notes, tags, priorities, dates, and devices are optional details. Saving
keeps you on the same page; the new task waits in Inbox.

Use **Add files** in the creation form to select attachments before saving.
You can select several files, review their names, and remove any before upload.
PNG, JPG, GIF, WebP, PDF, and text files are supported, up to **1 MB per file**.
If an upload fails after the task is saved, the form keeps the remaining files
and offers **Retry uploads** without creating another task or re-uploading files
already confirmed as uploaded. You can also close the form and attach files
later from the task's **Attachments** section.

Review items individually or select several at once:

- **Inbox:** unreviewed thoughts, oldest first.
- **Next:** things you intend to do, ordered by priority by default.
- **Someday:** ideas to keep without treating their age as neglected work.
- **Done:** resolved and closed tasks, most recently completed first.
- **All:** every task, including completed work.

Move items to Next or Someday, or mark them Done. Reopening in the UI returns a
task to Next with open status using the Reopen action. Choosing an active status
in the detail dropdown also moves it to Next and preserves that selected status.
Moving a completed task between queues does not
reopen it. Search covers titles, descriptions, and notes across **all lists**,
including Done; other selected filters such as tags still apply. Each result
shows its list. Tags such as `home`, `tech`, and `personal` are optional.

Queue placement is separate from progress status. Existing records migrate to
Next without changing their status or history. Existing API callers and
automatically generated maintenance/warranty tasks also default to Next.
Only Next tasks can become **stale** after 14 days. An explicit deadline is
still honored in every queue, including Inbox and Someday.

The app requires a connection to the server. It does not queue offline edits.

**Tickets** carry a status (`open`, `in_progress`, `blocked`, `resolved`,
`closed`), a priority, optional tags, an optional due date, reference links,
file attachments, and a comment thread for notes as you work the problem. Every
change is logged to an **activity timeline**, so a ticket that sat blocked for
three weeks no longer looks the same as one fixed on the spot. Descriptions and
notes render **Markdown**. The Next list shows work you intend to do,
sorted most urgent first, and lets you **select several at once** to
close, resolve, or tag them in one go. A **full-text search** covers titles,
descriptions, and every comment.

**Devices** are the things you own — servers, NAS, switches, VMs, Pis. Each
device shows its open tickets and its full service history, so "what have I
done to this box before?" stays answerable. Alongside the network details it
tracks the **lifecycle** fields you reach for when something breaks — serial
number, purchase date, warranty expiry, cost — and warns you before a warranty
lapses. Devices can **depend on** one another (a VM on its host, everything on
a switch), so a device page answers "if I pull this, what goes with it?".
Deleting a device keeps its tickets and just unlinks them; the history of a
machine you no longer own is usually the part worth keeping.

**Schedules** are recurring maintenance — dust filters, cert renewals, battery
swaps, pool scrubs. A schedule is a ticket template plus a cadence, and it opens
a real ticket when the work comes due. See [Recurring maintenance](#recurring-maintenance).

**The dashboard** surfaces open counts by priority, which devices have the most
unresolved work, anything overdue, and anything open that hasn't been touched
in two weeks in Next — the tasks you forgot rather than finished.

Everything is also reachable by keyboard: `n` to add a task, `/` to search,
`g` then `i`/`d`/`t`/`v`/`s` for Inbox/dashboard/all tasks/devices/schedules,
and `?` for the full list.

## Attachments

A ticket can carry files — a photo of the scorched capacitor, the RMA invoice,
a saved log. They are stored as BLOBs inside the same SQLite file, on purpose:
there is still exactly one thing to back up, and a snapshot captures the photo
alongside the ticket that explains it. The type list is short (PNG, JPEG, GIF,
WebP, PDF, plain text) and nothing a browser would run as markup is accepted,
so serving a stored file back can never turn into stored script. Each upload is
capped at 1 MB by the same limit that guards every request body.

## Calendar feed

`GET /api/calendar.ics` is an iCalendar feed of everything with a date on it —
open tickets with a due date, and the next occurrence of each active schedule —
so your homelab's deadlines show up next to the rest of life in whatever
calendar app you already use. A calendar app subscribes to a bare URL and can
present neither a cookie nor a header, so the API token may ride in the query
string **for this one read-only endpoint**:

```text
https://tickets.example/api/calendar.ics?token=YOUR_API_TOKEN
```

That is the only place a token is accepted in a URL; everywhere else still
wants a header, because a token in a URL can end up in a log.

## Reminders and digests

Beyond the overdue alarm, a ticket can be nudged *before* it lapses. Add
`ticket.due_soon` to `NOTIFY_EVENTS` and set `NOTIFY_REMINDER_DAYS`, and a
ticket coming due within that window is announced once, re-arming if its due
date moves. Set `NOTIFY_DIGEST=daily` or `weekly` for a rolled-up summary — how
much is open, overdue, and stale, plus what is coming up this week — sent at
most once per cadence, with the last-sent time kept in the database so it
survives restarts.

## Recurring maintenance

A schedule carries the ticket it will open — title, description, priority,
device, tags — plus how often, and how far ahead of the due date to open it:

```sh
curl -X POST http://localhost:8080/api/schedules \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Replace NAS dust filters","interval_days":90,"lead_days":7,"device_id":1}'
```

That opens a ticket a week before each quarterly due date. `next_due` defaults
to today, so a new schedule proves itself on the next sweep rather than going
quiet until its first interval elapses; set it explicitly for work that is not
due yet.

**A schedule that fell behind generates one ticket, not one per missed
interval.** Coming back from a month of downtime to thirty identical "check the
disks" tickets would be noise. The single ticket keeps the date it was genuinely
due, so the backlog is visible rather than hidden, and the schedule then
advances to its next future occurrence.

Schedules are swept hourly by default, along with the overdue check, the
due-soon nudge, the digest, and the **warranty check** — which opens a single
ticket when a non-retired device's warranty is within `WARRANTY_ALERT_DAYS` of
lapsing, and editing that warranty date re-arms the alert. If you would rather drive all of that
from cron, set `MAINTENANCE_INTERVAL_MINUTES=0` and post to
`/api/maintenance/run` yourself.

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

**Behind a reverse proxy, set `TRUST_PROXY=true`.** Without it every request
arrives from the proxy's address, so the login lockout and the rate limiter see
one client and a single attacker locks out the household. It is off by default
because the opposite mistake is worse: any client can send `X-Forwarded-For`, so
trusting it when no proxy is in front lets an attacker rotate the header and
guess passwords indefinitely. Only turn it on when something you control really
does sit in front.

Two caveats worth knowing. Serving over plain HTTP means the password crosses
your LAN in the clear — fine against the casual case this is built for, not
against someone already on your network; put it behind HTTPS if that matters,
and set `COOKIE_SECURE=true` when you do. And the password lives in an
environment variable, so anyone who can read your `.env` or run `docker
inspect` can read it.

## Notifications

Point `NOTIFY_URL` at a webhook to hear about tickets without watching the
dashboard:

```sh
NOTIFY_URL=https://ntfy.sh/my-homelab-topic
NOTIFY_FORMAT=ntfy                     # or json, the default
NOTIFY_MIN_PRIORITY=high               # stay quiet about small things
NOTIFY_EVENTS=ticket.created,ticket.overdue,schedule.fired
```

`json` posts a JSON body describing the event and ticket; `ntfy` sends a
plain-text body with the title and priority in headers, which is what
[ntfy](https://ntfy.sh) expects.

Delivery is best-effort by design: a webhook that is down logs a warning and
never fails the API request that triggered it. Overdue tickets are announced
once per lapse rather than every day until you deal with them, and moving a due
date re-arms the alert.

## Backups

Docker Compose enables daily snapshots in the `ticket-backups` volume mounted
at `/backups`, retaining 14. This separate volume is still on the same server;
off-server backup is not configured by this project. Direct Node startup keeps
backups disabled until a directory is configured.

Everything is in the one SQLite file. Set `BACKUP_DIR` and the app snapshots
itself on a timer, keeping the most recent `BACKUP_KEEP` files:

```sh
BACKUP_DIR=/data/backups
BACKUP_INTERVAL_HOURS=24
BACKUP_KEEP=7
```

Snapshots use SQLite's `VACUUM INTO`, which is safe against a live database —
unlike copying the file, which can capture a torn state. Pruning only ever
touches files the app itself wrote.

To take one by hand instead:

```sh
docker compose exec ticket \
  node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/homelab.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp ticket:/data/backup.db ./homelab-backup.db
```

## Metrics and export

`GET /api/metrics` returns Prometheus text exposition — open counts by priority,
overdue and stale totals, devices by status, schedules due — so a homelab that
already runs Grafana can graph its backlog alongside everything else. Labels
come only from fixed enums, never device names, so cardinality stays bounded.

`GET /api/export?entity=tickets&format=csv` dumps tickets, devices, or schedules
as CSV or JSON. Exports include closed tickets, since the point is an archive
rather than the working list. The same links are on each page in the UI.

## Configuration

Only `AUTH_PASSWORD` is required. Everything else is off or sensibly defaulted,
and a malformed value stops the app at startup rather than being quietly
ignored.

| Variable                       | Default             | Purpose                                        |
| ------------------------------ | ------------------- | ---------------------------------------------- |
| `AUTH_PASSWORD`                | *(required)*        | Sign-in password, minimum 8 characters         |
| `AUTH_DISABLED`                | unset               | Deliberately run with no authentication        |
| `API_TOKEN`                    | unset               | Bearer token for scripts, minimum 16 chars     |
| `SESSION_DAYS`                 | `30`                | Session lifetime before re-authenticating      |
| `COOKIE_SECURE`                | `false`             | Add `Secure` to the cookie — set when on HTTPS |
| `TRUST_PROXY`                  | `false`             | Read `X-Forwarded-For` — only behind a proxy   |
| `PUBLIC_HEALTH`                | `false`             | Allow `/api/health` without authentication     |
| `RATE_LIMIT_PER_MINUTE`        | `300`               | API requests per client per minute; `0` is off |
| `LOG_LEVEL`                    | `info`              | `debug` adds an access log                     |
| `LOG_FORMAT`                   | `text`              | `json` for a log shipper                       |
| `NOTIFY_URL`                   | unset               | Webhook for ticket events                      |
| `NOTIFY_FORMAT`                | `json`              | `json` or `ntfy`                               |
| `NOTIFY_EVENTS`                | created, overdue, fired | Which events to send                       |
| `NOTIFY_MIN_PRIORITY`          | `low`               | Stay quiet below this priority                 |
| `NOTIFY_TIMEOUT_MS`            | `5000`              | How long to wait on the webhook                |
| `NOTIFY_REMINDER_DAYS`         | `3`                 | Days ahead to send the `ticket.due_soon` nudge |
| `NOTIFY_DIGEST`                | `off`               | Rolled-up summary: `off`, `daily`, or `weekly` |
| `BACKUP_DIR`                   | unset               | Enable scheduled backups by setting this       |
| `BACKUP_INTERVAL_HOURS`        | `24`                | How often to snapshot                          |
| `BACKUP_KEEP`                  | `7`                 | Snapshots to retain                            |
| `MAINTENANCE_INTERVAL_MINUTES` | `60`                | Schedule, overdue, and warranty sweep; `0` for cron |
| `WARRANTY_ALERT_DAYS`          | `30`                | Days before warranty expiry to open a ticket; `0` off |
| `PORT`                         | `8080`              | Port to listen on                              |
| `HOST`                         | `0.0.0.0`           | Bind address                                   |
| `DB_PATH`                      | `./data/homelab.db` | SQLite file (`/data/homelab.db` in Docker)     |
| `TZ`                           | `UTC`               | Container timezone                             |

## API

The UI is a client of the same JSON API, so scripts and cron jobs can file
tickets too — useful for having a monitoring script open a ticket on failure.

| Method   | Path                             | Purpose                     |
| -------- | -------------------------------- | --------------------------- |
| `GET`    | `/api/stats`                     | Dashboard summary           |
| `GET`    | `/api/tickets`                   | List / filter tickets       |
| `POST`   | `/api/tickets`                   | Create a ticket             |
| `POST`   | `/api/tickets/bulk`              | Apply one change to many tickets |
| `GET`    | `/api/tickets/:id`               | One ticket, with comments, links, attachments, and events |
| `PATCH`  | `/api/tickets/:id`               | Update any subset of fields |
| `DELETE` | `/api/tickets/:id`               | Delete a ticket             |
| `POST`   | `/api/tickets/:id/comments`      | Add a note                  |
| `DELETE` | `/api/tickets/:id/comments/:cid` | Delete a note               |
| `POST`   | `/api/tickets/:id/links`         | Attach a reference URL      |
| `DELETE` | `/api/tickets/:id/links/:lid`    | Remove a link               |
| `POST`   | `/api/tickets/:id/attachments`   | Upload a file (raw body)    |
| `DELETE` | `/api/tickets/:id/attachments/:aid` | Remove an attachment     |
| `GET`    | `/api/attachments/:id`           | Download an attachment      |
| `GET`    | `/api/devices`                   | List / filter devices       |
| `POST`   | `/api/devices`                   | Register a device           |
| `GET`    | `/api/devices/:id`               | One device                  |
| `PATCH`  | `/api/devices/:id`               | Update any subset of fields |
| `DELETE` | `/api/devices/:id`               | Delete a device             |
| `GET`    | `/api/schedules`                 | List / filter schedules     |
| `POST`   | `/api/schedules`                 | Create a schedule           |
| `GET`    | `/api/schedules/:id`             | One schedule, with the tickets it made |
| `PATCH`  | `/api/schedules/:id`             | Update any subset of fields |
| `DELETE` | `/api/schedules/:id`             | Delete a schedule           |
| `POST`   | `/api/maintenance/run`           | Fire due schedules and sweep overdue |
| `GET`    | `/api/tags`                      | Tags in use, with counts    |
| `GET`    | `/api/export`                    | CSV or JSON dump            |
| `GET`    | `/api/calendar.ics`              | iCalendar feed of due dates and schedules |
| `GET`    | `/api/metrics`                   | Prometheus metrics          |
| `POST`   | `/api/auth/login`                | Exchange the password for a session |
| `POST`   | `/api/auth/logout`               | End this session (`{"everywhere":true}` ends all) |
| `GET`    | `/api/auth/session`              | Whether auth is on          |
| `GET`    | `/api/health`                    | Health check                |

Every endpoint except `/api/auth/login` requires either a session cookie or an
API token; unauthenticated API calls get a `401`, and page requests redirect to
`/login`.

Ticket list filters: `queue` (`inbox`, `next`, or `someday`),
`status` (a specific status, `done` for resolved and closed, or `all`; defaults to
everything unresolved), `priority`, `device_id`, `tag`, `q` (full-text search
over title, description, and comments), and `sort` (`priority`, `newest`,
`oldest`, `updated`, `due`, `completed`). API search retains explicit filters;
the UI searches across lists by sending `status=all` and omitting `queue`.

Create/update/bulk-update accept `queue`. Omitting it on create defaults to
`next`; explicit invalid or empty values are rejected. Completion remains in
`status`, not `queue`. CSV appends a `queue` column; JSON exports include it.

Schedule list filters: `paused` and `device_id`.

Export parameters: `entity` (`tickets`, `devices`, `schedules`), `format`
(`json`, `csv`), and for tickets an optional `status`.

## Layout

```
src/
  server.js      HTTP server, routing, the auth gate, error mapping
  auth.js        Sessions, login throttling, cookies, API tokens
  config.js      The whole runtime configuration, read once at startup
  env.js         Environment parsing helpers that refuse malformed values
  db.js          Schema, versioned migrations, transaction helper
  validate.js    Input validation and the domain enums
  log.js         Structured logging, text or JSON
  ratelimit.js   Per-client request limiter
  notify.js      Webhook delivery, the overdue/due-soon sweeps, and the digest
  backup.js      VACUUM INTO snapshots with retention
  static.js      Static file serving for the frontend
  api/           devices.js, tickets.js, schedules.js, stats.js, events.js,
                 warranty.js, attachments.js, calendar.js, export.js,
                 metrics.js — the data layer
public/          index.html, app.js, login.html, styles.css — dependency-free SPA
test/            Unit tests per module plus HTTP integration tests
```

Schema changes go in the `MIGRATIONS` array in `src/db.js` — append a new
entry, never edit an existing one, and it will apply itself on next start.

`transaction()` nests: a call made while a transaction is already open joins it
through a savepoint. That is what lets a composite operation like firing a
schedule reuse the same data-layer helpers as everything else.

# Daily-use deployment

Target: the homelab Docker server `docker-main` (`192.168.100.38` on the LAN).
The app stays private to your tailnet, with password sign-in and HTTPS through
Tailscale Serve.

**Task Hub is deployed and in daily use.** It runs from `/opt/task-hub` as
Compose project `task-hub` (container `homelab-ticket`) with the private
override, bound only to `127.0.0.1:8080`, behind a tailnet-only Serve route
with no Funnel. The private HTTPS address is not recorded here because this
repository is public. The first install is done, so later releases follow
[Backups, upgrade, and recovery](#backups-upgrade-and-recovery). Outstanding
checks are listed in the [acceptance record](#acceptance-record).

When the computer is off the LAN, reach the host over Tailscale SSH but keep
strict host-key checking against the verified LAN key (for example with
`HostKeyAlias=192.168.100.38` in the SSH config entry).

## Preflight and existing data

Use the server console to obtain `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
and compare that fingerprint when establishing SSH access. Do not bypass host
verification. Log in with an authorized account, then check:

```sh
hostname
docker version
docker compose version
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
docker volume ls
tailscale status
tailscale serve status
tailscale funnel status
```

If `homelab-ticket` already exists, inspect only the relevant fields (the full
container environment contains the password):

```sh
docker inspect --format '{{json .Mounts}}' homelab-ticket
docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' homelab-ticket
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' homelab-ticket
docker inspect --format '{{.Image}}' homelab-ticket
```

Preserve that Compose project name, working directory, `.env`, and database
mount. A bind mount must remain a bind mount; do not silently replace it with
an empty named volume. Do not start a second instance against the same database
or use `docker compose down -v`. For a fresh install use `/opt/task-hub` and
project name `task-hub`. The commands below run on the Linux Docker host.

## Fresh install

Check out the reviewed, merged commit in the deployment directory. For an
existing installation take the pre-migration snapshot below **before** starting
the new image. For a fresh installation, copy `.env.example` to `.env` and set a
unique password; preserve an existing password and API token. Restrict `.env`
to its owner (`chmod 600 .env`). Set:

```dotenv
TASK_HUB_VERSION=<reviewed-commit-sha>
TASK_HUB_PORT=8080
TZ=America/Denver
BACKUP_DIR=/backups
BACKUP_INTERVAL_HOURS=24
BACKUP_KEEP=14
```

Leave `AUTH_DISABLED` unset. Use the existing project's name instead of
`task-hub` below if preflight found an existing installation. Check that no
unrelated service uses the chosen loopback port. Build and start:

```sh
docker compose -p task-hub -f docker-compose.yml -f docker-compose.private.yml build
docker compose -p task-hub -f docker-compose.yml -f docker-compose.private.yml up -d
docker inspect --format '{{.State.Health.Status}}' homelab-ticket
docker port homelab-ticket
```

The only published socket must be `127.0.0.1:8080`. The HTTPS override enables
secure cookies and trusts the local reverse proxy. Test authenticated browser
flows through HTTPS, since secure cookies are intentionally not sent over HTTP.
Inspect logs for backup/migration errors without printing configuration secrets.

## Private HTTPS and phone access

Install/enroll Tailscale on the host if absent, using its official installation
instructions and the intended account. Account login/enrollment requires the
owner. Confirm the computer, host, and phone belong to the intended tailnet
and its access policy permits this connection.

Check existing Serve routes before adding one. Do not overwrite another app's
HTTPS route; if port 443 is occupied, resolve that conflict with the owner.
For an unused route, configure:

```sh
sudo tailscale serve --bg http://127.0.0.1:8080
tailscale serve status
tailscale funnel status
```

Use the exact HTTPS address Serve prints. Serve is private to the tailnet;
do not enable Funnel or add a router port-forward. Confirm no existing Funnel
route exposes this backend. See the [official Serve documentation](https://tailscale.com/kb/1312/serve).

Open that address on the computer, sign in, and add a task. Connect the phone to
Tailscale, turn Wi-Fi off, then open the same address over cellular, sign in,
and confirm the task is present. Create another task and an attachment on the
phone and verify them on the computer. This physical-phone check requires the
owner; a simulated mobile browser is not evidence of cellular connectivity.

For quick access, use Safari's **Share → Add to Home Screen** or the Android
browser's **Add to Home screen** menu. This is an online shortcut, not an offline
app. Keep Tailscale connected while using it away from home.

## Backups, upgrade, and recovery

`ticket-data` holds `/data/homelab.db` and its SQLite sidecars. `ticket-backups`
is separately mounted at `/backups`; daily snapshots retain the newest 14.
Compose prefixes the volume names with its project name. Both volumes are on
the same server, so hardware loss is not covered. Off-server copies are deferred.

For an upgrade, record the running image ID and retain that image locally.
Stop user activity while making the snapshot and upgrading. Make a consistent
snapshot with the **currently running** application before it migrates:

```sh
mkdir -p rollback
chmod 700 rollback
docker inspect --format '{{.Image}}' homelab-ticket > rollback/previous-image.txt
SNAPSHOT="pre-task-hub-$(date -u +%Y%m%dT%H%M%SZ).db"
docker exec homelab-ticket node -e \
  "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/data/homelab.db'); db.exec(\"VACUUM INTO '/data/$SNAPSHOT'\"); db.close()"
docker cp "homelab-ticket:/data/$SNAPSHOT" "rollback/$SNAPSHOT"
printf '%s\n' "$SNAPSHOT" > rollback/snapshot-name.txt
chmod 600 "rollback/$SNAPSHOT" rollback/*.txt
```

If preflight found a different database path, substitute that verified path.
Keep the snapshot and prior image until acceptance is complete. Then build and
start the reviewed commit using the same Compose project and mounts.

To verify scheduled backups immediately, trigger the same snapshot code once:

```sh
docker exec homelab-ticket node --input-type=module -e \
  "import {openDatabase} from './src/db.js'; import {runBackup} from './src/backup.js'; const db=openDatabase('/data/homelab.db'); await runBackup(db,{dir:'/backups',keep:14}); db.close()"
docker exec homelab-ticket ls -l /backups
```

### Isolated restore drill

Copy one chosen snapshot out of `/backups` with `docker cp`. Create a new,
empty `restore-check` directory alongside the deployment and copy that snapshot
to `restore-check/homelab.db`. Use no SQLite sidecars from the live database.
Give that directory and file to UID/GID 1000, the image's unprivileged user.
Read a temporary test password without echoing it, then start an isolated instance:

```sh
read -rs -p 'Temporary restore-test password: ' AUTH_PASSWORD
export AUTH_PASSWORD
docker run -d --name task-hub-restore-check \
  --mount "type=bind,src=$PWD/restore-check,target=/data" \
  -p 127.0.0.1:8081:8080 -e AUTH_PASSWORD \
  -e MAINTENANCE_INTERVAL_MINUTES=0 \
  "homelab-ticket:$TASK_HUB_VERSION"
unset AUTH_PASSWORD
```

Set `TASK_HUB_VERSION` in this shell to the deployed image tag first; Compose's
`.env` does not export shell variables. Use an SSH tunnel to localhost port
8081 to inspect it. Confirm queue placement, notes, completed records, and exact
attachment contents. Restart the isolated container and repeat. Remove only
the named test container when done (`docker rm -f task-hub-restore-check`).
Keep the restore directory until the drill is recorded as passed.

### Rollback

Rollback loses changes made after the selected snapshot. Stop the live container
first, and preserve the failed database plus any `-wal`/`-shm` files together
for investigation. Restore the pre-migration snapshot into the verified data
mount as `homelab.db`, with no old sidecars alongside it, owned by UID/GID 1000.
Tag the image ID in `rollback/previous-image.txt` as `homelab-ticket:rollback`,
set `TASK_HUB_VERSION=rollback`, and run the same Compose command with
`up -d --no-build`. Do not run the older image against the migrated database.
Verify login, task history, attachments, and health again.

## Acceptance record

For each release, record the reviewed merge SHA, the previous image ID, and
the pre-upgrade snapshot name alongside the deployment, not in this repository.

| Check | Status |
| --- | --- |
| Project, mounts, and private HTTPS URL confirmed | Done |
| Loopback-only Docker binding, tailnet-only Serve, no Funnel | Done |
| Pre-upgrade snapshot and prior image kept on each upgrade | Done |
| Scheduled backup ran and its SQLite copy restored cleanly (integrity check, schema, row counts) | Done |
| Full isolated restore drill (restore container, attachments, restart) | Outstanding |
| Tasks survive container recreation (every upgrade so far) | Done |
| Attachment contents confirmed after a restart | Outstanding |
| Owner-confirmed phone access over cellular with Tailscale connected | Outstanding |

Local automated tests and browser checks establish app behavior, not the state
of this server or phone.

# Planning and iPhone capture

Task Hub remains a single-user app with one SQLite database and no npm
dependencies. Inbox is still the home page; devices and maintenance remain
available alongside everyday tasks.

## Choose what to do

Use **Today** on a task or select several tasks and choose **Add to Today**.
Selections move to Next and persist across days and devices. Drag to reorder
on a desktop or use the move controls on any device. The Deadlines section
shows overdue work and deadlines in the next seven days separately from your
chosen tasks.

Completing a task or moving it out of Next removes its Today selection.
Reopening a task does not select it again. Removing a Today selection leaves
the task in Next. Adding a snoozed or waiting task to Today explicitly clears
its snooze and waiting state.

**Snooze** offers Tomorrow, Next Monday, or any chosen date. Snoozed tasks are
hidden from ordinary Inbox, Next, and Today views, but stay in Snoozed, All,
search results, and their project. They return to their original queue on the
chosen date. The app checks dates when reading data, so server downtime does
not prevent resurfacing. An idle open page refreshes when the date changes.

**Waiting on** records a reason and optional follow-up date. It does not alter
the task's progress status. Waiting work stays out of the actionable list
until its follow-up date; then it returns with the waiting description intact.
Clear waiting when you receive the response. Snoozing can defer visibility of
a follow-up. Neither feature cancels an explicit deadline or its reminders.

Add `ticket.follow_up` to `NOTIFY_EVENTS` to send follow-ups through the existing
notification channel. This is opt-in. Due follow-ups also appear in the
dashboard, digest, and calendar feed. Editing the waiting description or
follow-up date re-arms the notification.

`APP_TIME_ZONE` defaults to `America/Denver`; set it to any supported IANA
timezone. It controls civil dates for planning, deadlines, and new routines.
Event timestamps stay UTC. Existing fixed-interval schedules retain their UTC
schedule behavior. The app validates the timezone at startup.

## Checklists, projects, and views

Checklist items can be edited, checked, reordered, and removed in task details.
Completing or reopening a task preserves its checklist; checking every item
does not silently complete the parent task.

Each task may belong to one project. Projects have Markdown notes and show
completed/total tasks. The next action is the highest-priority active Next task
that is neither snoozed nor waiting. You can capture a new task in a project or
assign an existing task from the project page or task details.

Archiving a project retains its tasks, notes, and history; it does not complete
or hide the tasks. Deleting a project unlinks its tasks and schedule templates
without deleting their contents.

Use **Save this view** on a task list, or create a view from **Saved views**.
Views support queue, progress, priority, project, device, tag, text search,
relative deadlines, and Today/waiting/snoozed/actionable filters. Edit or rename
them in their page, and reorder them from the Saved views overview. Relative
dates are recalculated when opened. Searching inside a saved view keeps its
filters; the ordinary global search still covers all lists.

## Recurring routines

Choose **New routine** on Schedules, or **Make recurring** in a task. A routine
contains a task template, optional project/device/tags, and checklist steps.
New occurrences receive fresh unchecked copies of those steps. Later template
changes do not rewrite existing tasks.

Editing a calendar or fixed-interval routine's start date makes that date the
first eligible successor after the current task is completed. Its existing
deadline is preserved; completing it early does not skip the edited start.

Supported rules:

| Rule | Behavior |
| --- | --- |
| Selected weekdays | Choose any combination, including weekdays only |
| Monthly date | Use the selected day; shorter months use their last day |
| Weekday of the month | First, second, third, fourth, or last chosen weekday |
| Every N days | Keep a fixed interval anchored to the occurrence date |
| N days after completion | Count from the day the last occurrence was finished |

Calendar rules choose the first matching date on or after Start on. New
routines use zero lead time and keep one unfinished occurrence. Its original
deadline remains visible even when several occurrences have been missed.
Finishing it advances calendar rules to their next future occurrence, or starts
the completion-based interval. Calendar routines skip missed dates after an
outage; a completion-based occurrence that became due remains overdue.

Reopening the latest task before its successor exists suspends generation until
it is completed again. Reopening an older task after a successor already exists
does not create another recurrence chain. Bulk completion uses the same rules
as individual completion.

Old schedules retain their existing `interval_days` and lead-time behavior.
The legacy editor remains available; a 30-day interval is labeled **Every 30
days**, not monthly. Pausing or deleting a schedule preserves its task history.

## Install on iPhone

Use the stable private **HTTPS** address described in [Deployment](deployment.md).
Localhost is sufficient for development on the computer, but a phone's
localhost is the phone itself. Offline capture requires an initial successful
visit while connected so the static capture interface can be stored.

1. Open Task Hub in Safari and sign in.
2. Choose **Share → Add to Home Screen** and enable **Open as Web App**.
3. Open the new home-screen icon and visit Capture once while connected.
4. Create a draft, switch offline, and verify it is available under Drafts.

The home-screen app opens Inbox online. If the server cannot be reached, its
stored capture interface opens instead. Existing tasks and attachments are
never cached for offline browsing.

### Add an action to the iPhone share sheet

Safari does not implement web-app share targets. Use an Apple Shortcut that
opens the regular capture interface instead. It needs no API token.

1. Create a shortcut named **Add to Task Hub**.
2. In its details, enable **Show in Share Sheet** and accept URLs and Text.
3. Use **Get Text from Input** on Shortcut Input. If accepting several items,
   combine the text with newlines.
4. Add **URL Encode** for that text.
5. Add a Text action with your Task Hub HTTPS origin followed by:

   ```text
   /capture.html#/capture?text=[URL Encoded Text]
   ```

6. Add **Open URLs**, using the completed Text value.
7. Share a link or selected text, choose Add to Task Hub, then review the title
   and notes before submitting.

Use the same origin for Safari, the shortcut, and the home-screen app. Safari
and an installed web app may have separate local storage/session contexts;
finish a draft in the context where it was captured. Shared content is passed
in the URL fragment, then removed from the current history entry after it is
saved as a local draft. Attach photos/files inside the capture screen.

Apple documents the share-sheet setup in
[Run a shortcut from another app](https://support.apple.com/guide/shortcuts/launch-a-shortcut-from-another-app-apd163eb9f95/ios).

### Draft recovery

Typing and selecting accepted attachments save a local draft. Drafts support
the existing PNG/JPEG/GIF/WebP/PDF/text types, up to 1 MB per file. Larger or
unsupported files need to be resized/converted before adding them.

Drafts remain device-local until you explicitly submit them. They are not part
of the server database or its backups; clearing browser data can remove them.
Storage failures are shown immediately rather than claiming the draft saved.

After submission begins, the task contents are held steady so a retry can safely
recover an uncertain response. Sign in if needed, reopen the draft, and choose
**Resume submission**. Successfully attached files are not uploaded again.
If the task is already saved but an attachment failed, discard the remaining
local draft or retry uploads; the saved task is retained.

Sign-out offers an explicit choice to clear local drafts or keep them.

## API additions

Existing endpoints and queue/status values remain valid. New fields default to
null or empty for migrated tasks.

| Surface | Additions |
| --- | --- |
| Ticket create/update | `today` boolean, `project_id`, `snoozed_until`, `waiting_on`, `follow_up_date` |
| Ticket responses | `today_rank`, planning fields, project name, checklist counts; detail includes `checklist` |
| Ticket filters | `project_id`, `today`, `waiting`, `snoozed`, `actionable`, `due` (`today`, `overdue`, `week`, `none`); `sort=today` |
| `GET /api/planning` | Current app civil date and timezone |
| `PUT /api/tickets/today/order` | `{ "ids": [...] }` containing the full current Today order |
| `/api/tickets/:id/checklist` | GET and POST (`title`) |
| `/api/tickets/:id/checklist/:item` | PATCH (`title`, `completed`) and DELETE |
| `PUT /api/tickets/:id/checklist/order` | Full checklist ID order |
| `/api/projects` and `/api/projects/:id` | GET/POST and GET/PATCH/DELETE; `name`, `notes`, `archived` |
| `/api/views` and `/api/views/:id` | GET/POST and GET/PATCH/DELETE; `name`, `filters` |
| `PUT /api/views/order` | Full saved-view ID order |
| Schedule create/update | `recurrence`, `project_id`, `checklist` template strings, `time_zone` |
| Schedule creation | Optional `source_ticket_id` to make an existing task recurring |
| Exports | New planning columns; additional `projects`, `views`, `checklists` entities |

Recurrence rule examples:

```json
{"kind":"weekly","weekdays":[1,2,3,4,5]}
{"kind":"monthly_date","day":31}
{"kind":"monthly_weekday","ordinal":1,"weekday":0}
{"kind":"interval","days":14}
{"kind":"after_completion","days":30}
```

Weekdays are Sunday `0` through Saturday `6`; monthly ordinal `5` means last.
Existing `interval_days` callers remain legacy schedules unless they explicitly
provide a recurrence rule.

Capture POSTs support an `Idempotency-Key` header on ticket creation and
attachment upload. Reusing a key with the same payload returns the same stored
resource; different contents are rejected. Keys and mutations are recorded in
the same transaction and survive restart/backup. Deleting a resource does not
make its old key reusable. All data APIs retain session/bearer authentication;
only static assets and the empty capture shell are publicly readable.

## Upgrade and acceptance checks

Snapshot the database before upgrading and keep the previous image plus that
snapshot for rollback. The additive migrations retain existing queues,
statuses, comments, attachments, and fixed-interval schedules. Reverting an
image is not a schema rollback; use the pre-upgrade snapshot if rolling back.

After upgrading, verify:

- Old tasks, device history, attachments, and legacy schedules still open.
- Today ordering, project notes, checklists, saved views, and recurrence state
  survive a server restart and a restore into an isolated database.
- One unfinished recurring task does not produce duplicates on repeated sweeps.
- Capture can be reopened after a reload and an expired session without losing
  content or duplicating saved tasks/files.
- On a physical iPhone, home-screen installation, Shortcut sharing, and opening
  the installed app while offline work with the actual HTTPS origin. Desktop
  WebKit emulation does not verify iOS installation or share-sheet behavior.

The service worker caches only the static capture interface. When changing any
cached asset, bump the cache version in `public/sw.js`; a new worker waits for
old tabs to close before activating its complete asset set.

The app icon uses the Lucide check glyph (ISC license); see
[third-party notices](third-party-notices.md).

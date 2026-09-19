/* Task Hub — single-page client, no build step, no dependencies. */

const TICKET_STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'closed'];
const TICKET_QUEUES = ['inbox', 'next', 'someday'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const DEVICE_TYPES = [
  'server', 'nas', 'network', 'vm', 'container-host',
  'iot', 'workstation', 'peripheral', 'other',
];
const DEVICE_STATUSES = ['active', 'spare', 'retired'];

const LABELS = {
  inbox: 'Inbox',
  next: 'Next',
  someday: 'Someday',
  done: 'Done',
  all: 'All',
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  resolved: 'Resolved',
  closed: 'Closed',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const label = (value) => LABELS[value] ?? value;

/* ---- API ---------------------------------------------------------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  // The session expired or was revoked — bounce to the login page rather than
  // leaving the user staring at errors on every panel.
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('Session expired');
  }

  if (res.status === 204) return null;

  const payload = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);
  return payload;
}

/* ---- DOM helpers -------------------------------------------------------- */

/**
 * Builds an element. Children are appended as text nodes when they are
 * strings, which keeps user-supplied content out of the HTML parser.
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value === true ? '' : value);
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const statusBadge = (status) =>
  el('span', { class: 'badge badge-status', style: `--c: var(--${status})` }, label(status));

const priorityBadge = (priority) =>
  el('span', { class: 'badge badge-prio', style: `--c: var(--${priority})` }, label(priority));

function select(name, options, value, onchange) {
  return el(
    'select',
    { name, onchange, 'aria-label': label(name) },
    ...options.map((opt) => {
      const [val, text] = Array.isArray(opt) ? opt : [opt, label(opt)];
      return el('option', { value: val, selected: String(val) === String(value ?? '') }, text);
    }),
  );
}

function field(labelText, control) {
  return el('div', { class: 'field' }, el('label', {}, labelText, control));
}

function toast(message, isError = false) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = isError ? 'show error' : 'show';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = ''; }, 2600);
}

/**
 * Timers owned by whichever view is on screen. render() clears them, so work
 * scheduled by a page that has since been replaced cannot act on the new one.
 */
let viewTimers = [];

function onView(timer) {
  viewTimers.push(timer);
  return timer;
}

function clearViewTimers() {
  viewTimers.forEach(clearTimeout);
  viewTimers = [];
}

/**
 * A debounced search box. Tying the pending timer to the view matters: typing
 * a query and immediately switching tabs used to bounce you back to the list
 * you had just left, a quarter of a second later.
 */
function searchBox(placeholder, value, commit) {
  const input = el('input', { class: 'search', type: 'search', placeholder, value: value ?? '' });

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = onView(setTimeout(() => commit(input.value.trim()), 250));
  });
  return input;
}

/** Wraps an async action so any API error surfaces as a toast, not a dead click. */
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      toast(err.message, true);
    }
  };
}

/* ---- Dates -------------------------------------------------------------- */

/** SQLite stores 'YYYY-MM-DD HH:MM:SS' in UTC; make that explicit before parsing. */
const parseDate = (value) => new Date(`${String(value).replace(' ', 'T')}Z`);

function relativeTime(value) {
  if (!value) return '';
  const seconds = (Date.now() - parseDate(value).getTime()) / 1000;
  const units = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

const isOverdue = (ticket) =>
  ticket.is_open && ticket.due_date && ticket.due_date < new Date().toISOString().slice(0, 10);

/** Names the common intervals so a schedule reads as a habit, not a number. */
function cadence(days) {
  const named = {
    1: 'daily', 7: 'weekly', 14: 'fortnightly', 30: 'monthly',
    90: 'quarterly', 182: 'twice a year', 365: 'yearly',
  };
  return named[days] ?? `every ${days} days`;
}

function dueDescription(days) {
  if (days === null || days === undefined) return '';
  if (days < 0) return `overdue by ${-days} ${-days === 1 ? 'day' : 'days'}`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} days`;
}

/**
 * The API only ever stores http(s) link targets, but anything rendered into an
 * href gets checked again here — one bad row should not become a script.
 */
const safeHref = (url) => (/^https?:\/\//i.test(url ?? '') ? url : '#');

/* ---- Markdown ----------------------------------------------------------- */

/**
 * A deliberately small Markdown renderer that builds DOM nodes directly. It
 * never touches innerHTML with user text — every string goes in as a text node
 * — so support for formatting costs nothing in safety. Links are held to the
 * same http(s)-only rule as everywhere else. Unsupported syntax simply renders
 * as the literal text the user typed, which is the right failure mode for notes.
 */
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block: everything up to the closing fence is verbatim.
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      frag.append(el('pre', {}, el('code', {}, buf.join('\n'))));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const tag = `h${Math.min(6, heading[1].length + 2)}`; // # -> h3, keeps under card h2
      frag.append(el(tag, {}, ...inlineNodes(heading[2])));
      continue;
    }

    if (/^\s*([-*])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*])\s+/.test(lines[i])) {
        items.push(el('li', {}, ...inlineNodes(lines[i].replace(/^\s*([-*])\s+/, ''))));
        i++;
      }
      i--;
      frag.append(el('ul', {}, ...items));
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(el('li', {}, ...inlineNodes(lines[i].replace(/^\s*\d+\.\s+/, ''))));
        i++;
      }
      i--;
      frag.append(el('ol', {}, ...items));
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      frag.append(el('blockquote', {}, ...inlineNodes(buf.join('\n'))));
      continue;
    }

    if (line.trim() === '') continue;

    // Otherwise a paragraph: gather following non-blank, non-structural lines.
    const buf = [line];
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() !== '' &&
      !/^(```|#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|\s*>\s?)/.test(lines[i + 1])
    ) {
      buf.push(lines[++i]);
    }
    frag.append(el('p', {}, ...inlineNodes(buf.join('\n'))));
  }

  return frag;
}

/** Inline spans: code, bold, italic, links, and bare URLs, as text/DOM nodes. */
function inlineNodes(text) {
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<]+)/g;
  const nodes = [];
  let last = 0;
  let m;

  const newline = (chunk) => {
    // Preserve single newlines inside a paragraph as line breaks.
    const parts = chunk.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) nodes.push(el('br', {}));
      if (part) nodes.push(document.createTextNode(part));
    });
  };

  while ((m = pattern.exec(text))) {
    if (m.index > last) newline(text.slice(last, m.index));
    if (m[1]) nodes.push(el('code', {}, m[1].slice(1, -1)));
    else if (m[2]) nodes.push(el('strong', {}, m[2].slice(2, -2)));
    else if (m[3]) nodes.push(el('em', {}, m[3].slice(1, -1)));
    else if (m[4]) nodes.push(el('em', {}, m[4].slice(1, -1)));
    else if (m[5]) {
      const [, label] = m[5].match(/^\[([^\]]+)\]/);
      const [, url] = m[5].match(/\((https?:\/\/[^\s)]+)\)$/);
      nodes.push(el('a', { href: safeHref(url), target: '_blank', rel: 'noopener noreferrer' }, label));
    } else if (m[6]) {
      nodes.push(el('a', { href: safeHref(m[6]), target: '_blank', rel: 'noopener noreferrer' }, m[6]));
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) newline(text.slice(last));
  return nodes;
}

/** A 'prose' block whose content is rendered from Markdown. */
const prose = (text, extraClass = '') =>
  el('div', { class: `prose${extraClass ? ` ${extraClass}` : ''}` }, renderMarkdown(text));

/* ---- Modal -------------------------------------------------------------- */

function openModal(title, buildBody, onSubmit) {
  const root = document.getElementById('modal-root');
  const previousFocus = document.activeElement;
  let saving = false;
  const form = el('form', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const close = () => {
    if (saving) return;
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key !== 'Tab') return;
    const targets = [...form.querySelectorAll('input, textarea, select, button, summary')]
      .filter((node) => !node.disabled && node.getClientRects().length > 0);
    const first = targets[0];
    const last = targets.at(-1);
    if (!first) { e.preventDefault(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  form.append(
    el('h2', {}, title),
    buildBody(),
    el(
      'div',
      { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'),
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    const data = Object.fromEntries(new FormData(form));
    saving = true;
    const controls = [...form.querySelectorAll('button, input, textarea, select')];
    const disabledStates = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    const submit = form.querySelector('[type="submit"]');
    submit.textContent = 'Saving…';
    form.setAttribute('aria-busy', 'true');
    try {
      await onSubmit(data);
      saving = false;
      close();
    } catch (err) {
      toast(err.message, true);
    } finally {
      saving = false;
      controls.forEach((control, i) => { control.disabled = disabledStates[i]; });
      submit.textContent = 'Save';
      form.removeAttribute('aria-busy');
    }
  });

  const backdrop = el('div', { class: 'modal-backdrop' }, form);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);

  root.innerHTML = '';
  root.append(backdrop);
  form.querySelector('input, textarea, select')?.focus();
}

/** Splits the comma-separated tag input into the array the API expects. */
const parseTags = (value) => (value ?? '').split(',').map((t) => t.trim()).filter(Boolean);

/* ---- Dashboard ---------------------------------------------------------- */

async function renderDashboard(view) {
  const stats = await api('/stats');
  const criticalOpen =
    stats.by_priority.find((row) => row.priority === 'critical')?.count ?? 0;

  view.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Dashboard'))),
    el(
      'div',
      { class: 'stat-grid' },
      stat(stats.open_tickets, 'Open tasks'),
      stat(criticalOpen, 'Critical', criticalOpen > 0 ? 'var(--critical)' : null),
      stat(stats.overdue.length, 'Overdue', stats.overdue.length > 0 ? 'var(--high)' : null),
      stat(stats.active_devices, `Active devices of ${stats.total_devices}`),
    ),
    el(
      'div',
      { class: 'dash-grid' },
      priorityCard(stats.by_priority, stats.open_tickets),
      hotDevicesCard(stats.hot_devices),
      attentionCard(stats.overdue, stats.stale),
      resolvedCard(stats.recently_resolved),
    ),
  );
}

function stat(value, text, color) {
  return el(
    'div',
    { class: 'stat' },
    el('div', { class: 'value', style: color ? `color: ${color}` : null }, value),
    el('div', { class: 'label' }, text),
  );
}

function priorityCard(byPriority, total) {
  const counts = Object.fromEntries(byPriority.map((r) => [r.priority, r.count]));
  const max = Math.max(1, ...Object.values(counts));

  return el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Open by priority'),
    total === 0
      ? el('p', { class: 'muted' }, 'Nothing open. Enjoy it.')
      : [...PRIORITIES].reverse().map((priority) => {
          const count = counts[priority] ?? 0;
          return el(
            'div',
            { class: 'bar-row' },
            el('a', { href: `#/tickets?priority=${priority}` }, label(priority)),
            el(
              'div',
              { class: 'bar-track' },
              el('div', {
                class: 'bar-fill',
                style: `width: ${(count / max) * 100}%; background: var(--${priority})`,
              }),
            ),
            el('span', { class: 'count' }, count),
          );
        }),
  );
}

function hotDevicesCard(devices) {
  return el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Devices needing attention'),
    devices.length === 0
      ? el('p', { class: 'muted' }, 'No device has open tickets.')
      : el(
          'ul',
          { class: 'mini-list' },
          ...devices.map((device) =>
            el(
              'li',
              {},
              el('a', { href: `#/devices/${device.id}` }, device.name),
              el(
                'span',
                { class: 'meta' },
                `${device.open_tickets} open`,
              ),
            ),
          ),
        ),
  );
}

function attentionCard(overdue, stale) {
  const rows = [
    ...overdue.map((t) => ({ ...t, note: `due ${t.due_date}`, urgent: true })),
    ...stale.map((t) => ({ ...t, note: `quiet ${relativeTime(t.updated_at)}` })),
  ].slice(0, 8);

  return el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Overdue & stale'),
    rows.length === 0
      ? el('p', { class: 'muted' }, 'Nothing overdue or forgotten.')
      : el(
          'ul',
          { class: 'mini-list' },
          ...rows.map((t) =>
            el(
              'li',
              {},
              el('a', { href: `#/tickets/${t.id}` }, t.title),
              el('span', { class: t.urgent ? 'meta overdue' : 'meta' }, t.note),
            ),
          ),
        ),
  );
}

function resolvedCard(tickets) {
  return el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Recently resolved'),
    tickets.length === 0
      ? el('p', { class: 'muted' }, 'Nothing resolved yet.')
      : el(
          'ul',
          { class: 'mini-list' },
          ...tickets.map((t) =>
            el(
              'li',
              {},
              el('a', { href: `#/tickets/${t.id}` }, t.title),
              el('span', { class: 'meta' }, relativeTime(t.resolved_at)),
            ),
          ),
        ),
  );
}

/* ---- Ticket list -------------------------------------------------------- */

const TASK_LISTS = {
  inbox: { queue: 'inbox', status: 'active', sort: 'oldest', hint: 'Capture now. Decide what comes next when you are ready.' },
  next: { queue: 'next', status: 'active', sort: 'priority', hint: 'The things you intend to do.' },
  someday: { queue: 'someday', status: 'active', sort: 'newest', hint: 'Ideas worth keeping, without a commitment to start.' },
  done: { status: 'done', sort: 'completed', hint: 'A record of what you have finished.' },
  all: { status: 'all', sort: 'newest', hint: 'Everything you have captured, including completed tasks.' },
};

async function renderTickets(view, query, list) {
  const searching = Boolean(query.q?.trim());
  const settings = TASK_LISTS[list];
  const params = new URLSearchParams(query);
  if (settings) {
    params.set('status', list === 'done' ? 'done' : query.status ?? settings.status);
    if (settings.queue) params.set('queue', settings.queue);
    if (!query.sort) params.set('sort', settings.sort);
  }
  if (searching) {
    params.delete('queue');
    params.delete('status');
    params.set('status', 'all');
  }
  const [tickets, devices, tags] = await Promise.all([
    api(`/tickets?${params}`),
    api('/devices'),
    api('/tags'),
  ]);

  const update = (key, value) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    const route = list === 'inbox' ? '/' : list ? `/${list}` : '/tickets';
    location.hash = `#${route}${next.toString() ? `?${next}` : ''}`;
  };

  const search = searchBox('Search all tasks and notes…', query.q, (q) => update('q', q));
  search.setAttribute('aria-label', 'Search all tasks and notes');

  view.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, searching ? 'Search all tasks' : list ? label(list) : 'Tasks'),
        el('p', {}, searching ? 'Results include Inbox, Next, Someday, and Done.' : settings?.hint ?? 'Your tasks, filtered to this view.'),
        el(
          'p',
          {},
          `${tickets.length} ${tickets.length === 1 ? 'task' : 'tasks'}`,
          exportLinks('tickets'),
        ),
      ),
    ),
    el(
      'div',
      { class: 'filters' },
      search,
      list !== 'done' && !searching && select(
        'status',
        settings?.queue
          ? [['active', 'Any progress'], ...TICKET_STATUSES.filter((s) => !['resolved', 'closed'].includes(s)).map((s) => [s, label(s)])]
          : [['active', 'Active'], ['all', 'All statuses'], ['done', 'Done'], ...TICKET_STATUSES.map((s) => [s, label(s)])],
        params.get('status') ?? 'active',
        (e) => update('status', e.target.value),
      ),
      select(
        'priority',
        [['', 'Any priority'], ...PRIORITIES.map((p) => [p, label(p)])],
        query.priority,
        (e) => update('priority', e.target.value),
      ),
      select(
        'device_id',
        [['', 'Any device'], ...devices.map((d) => [d.id, d.name])],
        query.device_id,
        (e) => update('device_id', e.target.value),
      ),
      tags.length > 0 &&
        select(
          'tag',
          [['', 'Any tag'], ...tags.map((t) => [t.name, `${t.name} (${t.ticket_count})`])],
          query.tag,
          (e) => update('tag', e.target.value),
        ),
      select(
        'sort',
        [
          ['priority', 'Sort: priority'],
          ['newest', 'Sort: newest'],
          ['oldest', 'Sort: oldest'],
          ['updated', 'Sort: recently updated'],
          ['due', 'Sort: due date'],
          ['completed', 'Sort: recently completed'],
        ],
        params.get('sort') ?? 'priority',
        (e) => update('sort', e.target.value),
      ),
    ),
    tickets.length === 0
      ? el(
          'div',
          { class: 'empty-state' },
          el('strong', {}, list === 'inbox' && !searching ? 'Your inbox is clear' : 'No tasks match'),
          'Add a task whenever something comes to mind, or adjust the filters.',
        )
      : bulkList(tickets),
  );
}

/**
 * The ticket list with a selection layer: tick a few rows and a bar appears to
 * act on all of them at once — close them, resolve them, or tag them — which
 * beats opening twelve tickets to do the same thing twelve times.
 */
function bulkList(tickets) {
  const selected = new Set();

  const bar = el('div', { class: 'bulk-bar', hidden: true });
  const count = el('span', { class: 'bulk-count' });

  const refresh = () => {
    bar.hidden = selected.size === 0;
    count.textContent = `${selected.size} selected`;
    for (const button of bar.querySelectorAll('button[data-state]')) {
      button.hidden = !tickets.some((task) => selected.has(task.id)
        && (button.dataset.state === 'open' ? task.is_open : !task.is_open));
    }
  };

  let applying = false;
  const apply = (patch, describe, state) =>
    guard(async () => {
      if (applying) return;
      const ids = tickets.filter((task) => selected.has(task.id)
        && (!state || (state === 'open' ? task.is_open : !task.is_open))).map((task) => task.id);
      if (!ids.length) return;
      applying = true;
      const buttons = [...bar.querySelectorAll('button')];
      buttons.forEach((button) => { button.disabled = true; });
      try {
        const result = await api('/tickets/bulk', { method: 'POST', body: { ids, ...patch } });
        toast(`${describe} ${result.updated} task${result.updated === 1 ? '' : 's'}`);
        await render();
      } finally {
        applying = false;
        buttons.forEach((button) => { button.disabled = false; });
      }
    })();

  const addTag = guard(async () => {
    const tag = prompt('Tag to add to the selected tickets:');
    if (!tag || !tag.trim()) return;
    // The server merges add_tags onto each ticket's own set inside one
    // transaction, so the whole tagging is atomic and none of the existing
    // tags are lost.
    const result = await api('/tickets/bulk', {
      method: 'POST',
      body: { ids: [...selected], add_tags: [tag.trim()] },
    });
    toast(`Tagged ${result.updated} ticket${result.updated === 1 ? '' : 's'}`);
    render();
  });

  bar.append(
    count,
    tickets.some((t) => t.is_open) && el('button', { class: 'btn btn-sm', onclick: () => apply({ queue: 'next' }, 'Moved to Next:') }, 'Move to Next'),
    tickets.some((t) => t.is_open) && el('button', { class: 'btn btn-sm', onclick: () => apply({ queue: 'someday' }, 'Saved for Someday:') }, 'Save for Someday'),
    el('button', { class: 'btn btn-sm', dataset: { state: 'open' }, onclick: () => apply({ status: 'resolved' }, 'Completed', 'open') }, 'Mark Done'),
    el('button', { class: 'btn btn-sm', dataset: { state: 'done' }, onclick: () => apply({ queue: 'next', status: 'open' }, 'Reopened', 'done') }, 'Reopen in Next'),
    el('button', { class: 'btn btn-sm', onclick: addTag }, 'Add tag…'),
  );

  const onToggle = (id, on) => {
    if (on) selected.add(id);
    else selected.delete(id);
    refresh();
  };

  return el(
    'div',
    {},
    bar,
    el('div', { class: 'ticket-list' }, ...tickets.map((t) => ticketRow(t, onToggle))),
  );
}

function ticketRow(ticket, onToggle) {
  const checkbox =
    onToggle &&
    el('input', {
      type: 'checkbox',
      class: 'row-select',
      title: `Select ${ticket.title}`,
      'aria-label': `Select ${ticket.title}`,
      onclick: (e) => {
        e.stopPropagation();
        onToggle(ticket.id, e.target.checked);
      },
    });

  return el(
    'div',
    {
      class: `ticket-row${ticket.is_open ? '' : ' done'}`,
      style: `--prio: var(--${ticket.priority})`,
      onclick: () => { location.hash = `#/tickets/${ticket.id}`; },
    },
    checkbox,
    el(
      'div',
      { class: 'main' },
      el('a', { class: 'title', href: `#/tickets/${ticket.id}` }, ticket.title),
      el(
        'div',
        { class: 'sub' },
        el('span', { class: 'id' }, `#${ticket.id}`),
        el('span', { class: 'badge queue-badge' }, ticket.is_open ? label(ticket.queue) : 'Done'),
        statusBadge(ticket.status),
        priorityBadge(ticket.priority),
        ticket.device_name && el('span', {}, `· ${ticket.device_name}`),
        ticket.due_date &&
          el('span', { class: isOverdue(ticket) ? 'overdue' : '' }, `· due ${ticket.due_date}`),
        ticket.comment_count > 0 && el('span', {}, `· ${ticket.comment_count} 💬`),
        ...ticket.tags.map((tag) => el('span', { class: 'tag' }, tag)),
      ),
    ),
    el('span', { class: 'meta muted' }, relativeTime(ticket.updated_at)),
    onToggle && taskActions(ticket),
  );
}

/** Queue placement never silently reopens completed work. Reopening is explicit. */
function taskActions(ticket) {
  const move = (text, changes) => el('button', {
    class: 'btn btn-sm',
    onclick: guard(async (event) => {
      event.stopPropagation();
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      try {
        await api(`/tickets/${ticket.id}`, { method: 'PATCH', body: changes });
        toast(text);
        await render();
      } finally { button.disabled = false; }
    }),
  }, text);
  return el('div', { class: 'task-actions' }, ...(ticket.is_open ? [
    ticket.queue !== 'next' && move('Move to Next', { queue: 'next' }),
    ticket.queue !== 'someday' && move('Save for Someday', { queue: 'someday' }),
    move('Mark Done', { status: 'resolved' }),
  ] : [move('Reopen in Next', { status: 'open', queue: 'next' })]));
}

/* ---- Ticket detail ------------------------------------------------------ */

async function renderTicketDetail(view, id) {
  const [ticket, devices] = await Promise.all([api(`/tickets/${id}`), api('/devices')]);

  const patch = guard(async (changes) => {
    await api(`/tickets/${id}`, { method: 'PATCH', body: changes });
    toast('Task updated');
    render();
  });

  view.append(
    el('a', { class: 'back-link', href: '#/all' }, '← All tasks'),
    el(
      'div',
      { class: 'detail-grid' },
      el(
        'div',
        {},
        el(
          'div',
          { class: 'detail-head' },
          el(
            'div',
            { class: 'row-between' },
            el('h1', {}, ticket.title),
            el(
              'button',
              { class: 'btn btn-sm', onclick: () => editTicketModal(ticket, patch) },
              'Edit',
            ),
          ),
          el(
            'div',
            { class: 'badges' },
            el('span', { class: 'id mono muted' }, `#${ticket.id}`),
            statusBadge(ticket.status),
            priorityBadge(ticket.priority),
            el('span', { class: 'badge queue-badge' }, ticket.is_open ? label(ticket.queue) : 'Done'),
            ...ticket.tags.map((tag) => el('a', { class: 'tag', href: `#/tickets?tag=${tag}` }, tag)),
          ),
        ),
        el(
          'section',
          { class: 'card', style: 'margin-bottom: 16px' },
          el('h2', {}, 'Description'),
          ticket.body
            ? prose(ticket.body)
            : el('div', { class: 'prose empty' }, 'No description.'),
        ),
        linksCard(ticket, id),
        attachmentsCard(ticket, id),
        commentsCard(ticket, id),
      ),
      ticketSidebar(ticket, devices, patch, id),
    ),
  );
}

/** Reference material for a ticket: the thread that explained it, the runbook. */
function linksCard(ticket, id) {
  const url = el('input', { name: 'url', type: 'url', placeholder: 'https://…', required: true });
  const label = el('input', { name: 'label', placeholder: 'Label (optional)' });

  const submit = guard(async (event) => {
    event.preventDefault();
    if (!url.value.trim()) return;
    await api(`/tickets/${id}/links`, {
      method: 'POST',
      body: { url: url.value.trim(), label: label.value.trim() || null },
    });
    render();
  });

  return el(
    'section',
    { class: 'card', style: 'margin-bottom: 16px' },
    el('h2', {}, `Links (${ticket.links.length})`),
    ticket.links.length === 0
      ? el('p', { class: 'muted' }, 'No links yet.')
      : el(
          'ul',
          { class: 'mini-list' },
          ...ticket.links.map((link) =>
            el(
              'li',
              {},
              el(
                'a',
                { href: safeHref(link.url), target: '_blank', rel: 'noopener noreferrer' },
                link.label || link.url,
              ),
              el(
                'button',
                {
                  class: 'btn btn-ghost btn-sm delete',
                  onclick: guard(async () => {
                    await api(`/tickets/${id}/links/${link.id}`, { method: 'DELETE' });
                    render();
                  }),
                },
                'Remove',
              ),
            ),
          ),
        ),
    el(
      'form',
      { onsubmit: submit, class: 'link-form' },
      url,
      label,
      el('button', { class: 'btn btn-sm', type: 'submit' }, 'Add'),
    ),
  );
}

/** A one-line description of a recorded change, from its kind and values. */
function eventLine(event) {
  const from = event.from_value;
  const to = event.to_value;
  switch (event.kind) {
    case 'queue':
      return ['list → ', el('strong', {}, label(to)), from ? ` (was ${label(from)})` : ''];
    case 'created':
      return 'created the task';
    case 'status':
      return [`status → `, el('strong', {}, label(to)), from ? ` (was ${label(from)})` : ''];
    case 'priority':
      return [`priority → `, el('strong', {}, label(to)), from ? ` (was ${label(from)})` : ''];
    case 'device':
      return to ? `assigned to ${to}` : `unassigned${from ? ` from ${from}` : ''}`;
    case 'due_date':
      return to ? `due date set to ${to}` : 'due date cleared';
    case 'title':
      return 'renamed the ticket';
    case 'tags':
      return to ? `tags → ${to}` : 'tags cleared';
    default:
      return event.kind;
  }
}

/**
 * The activity timeline: recorded changes and typed notes, interleaved in the
 * order they happened. The events answer "what did I do to this and when?"
 * without anyone having had to write it down; the comments carry the detail.
 */
function commentsCard(ticket, id) {
  const input = el('textarea', {
    name: 'body',
    placeholder: 'Add a note — details, progress, or something to remember…',
    style: 'min-height: 70px',
  });

  const submit = guard(async (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    await api(`/tickets/${id}/comments`, { method: 'POST', body: { body } });
    input.value = '';
    render();
  });

  // Merge the two streams and order by time; comments keep their delete control.
  const entries = [
    ...ticket.events.map((e) => ({ at: e.created_at, kind: 'event', data: e })),
    ...ticket.comments.map((c) => ({ at: c.created_at, kind: 'comment', data: c })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const row = (entry) =>
    entry.kind === 'event'
      ? el(
          'div',
          { class: 'event' },
          el('span', { class: 'event-dot' }),
          el('span', { class: 'event-text' }, ...[].concat(eventLine(entry.data))),
          el('span', { class: 'event-when muted' }, relativeTime(entry.at)),
        )
      : el(
          'div',
          { class: 'comment' },
          el(
            'div',
            { class: 'comment-head' },
            el('span', {}, relativeTime(entry.at)),
            el(
              'button',
              {
                class: 'btn btn-ghost btn-sm delete',
                onclick: guard(async () => {
                  await api(`/tickets/${id}/comments/${entry.data.id}`, { method: 'DELETE' });
                  render();
                }),
              },
              'Delete',
            ),
          ),
          prose(entry.data.body),
        );

  return el(
    'section',
    { class: 'card' },
    el('h2', {}, `Activity (${entries.length})`),
    ...entries.map(row),
    el(
      'form',
      { onsubmit: submit, style: 'margin-top: 12px' },
      input,
      el(
        'div',
        { style: 'margin-top: 8px; display: flex; justify-content: flex-end' },
        el('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Add note'),
      ),
    ),
  );
}

/** Attachments: photos of the fault, the invoice, a saved log. */
function attachmentsCard(ticket, id) {
  const fileInput = el('input', { type: 'file', style: 'display: none' });

  const upload = guard(async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const res = await fetch(`/api/tickets/${id}/attachments`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        // Header values are Latin-1; percent-encode so a name with accents or
        // emoji survives the trip and is decoded server-side.
        'X-Filename': encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error ?? `Upload failed (${res.status})`);
    }
    render();
  });

  fileInput.addEventListener('change', upload);

  const tile = (att) => {
    const href = `/api/attachments/${att.id}`;
    const preview = att.content_type.startsWith('image/')
      ? el('img', { src: href, alt: att.filename, class: 'attach-thumb' })
      : el('span', { class: 'attach-icon' }, att.content_type === 'application/pdf' ? '📄' : '📎');

    return el(
      'div',
      { class: 'attachment' },
      el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, preview),
      el('a', { href, class: 'attach-name', target: '_blank', rel: 'noopener noreferrer' }, att.filename),
      el('span', { class: 'attach-size muted' }, formatBytes(att.size)),
      el(
        'button',
        {
          class: 'btn btn-ghost btn-sm delete',
          onclick: guard(async () => {
            await api(`/tickets/${id}/attachments/${att.id}`, { method: 'DELETE' });
            render();
          }),
        },
        'Remove',
      ),
    );
  };

  return el(
    'section',
    { class: 'card', style: 'margin-bottom: 16px' },
    el('h2', {}, `Attachments (${ticket.attachments.length})`),
    ticket.attachments.length === 0
      ? el('p', { class: 'muted' }, 'No attachments yet.')
      : el('div', { class: 'attach-grid' }, ...ticket.attachments.map(tile)),
    el(
      'div',
      { style: 'margin-top: 10px' },
      fileInput,
      el('button', { class: 'btn btn-sm', onclick: () => fileInput.click() }, 'Add file'),
      el('span', { class: 'muted', style: 'margin-left: 8px; font-size: 12px' },
        'images, PDF, or text · 1 MB max'),
    ),
  );
}

/** Human-readable byte size for an attachment. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ticketSidebar(ticket, devices, patch, id) {
  const block = (labelText, control) =>
    el('div', { class: 'sidebar-block' }, el('label', {}, labelText, control));

  return el(
    'aside',
    { class: 'card' },
    taskActions(ticket),
    block('List', select('queue', TICKET_QUEUES, ticket.queue, (e) => patch({ queue: e.target.value }))),
    block(
      'Status',
      select('status', TICKET_STATUSES, ticket.status, (e) => {
        const reopening = !ticket.is_open && !['resolved', 'closed'].includes(e.target.value);
        patch(reopening ? { status: 'open', queue: 'next' } : { status: e.target.value });
      }),
    ),
    block(
      'Priority',
      select('priority', PRIORITIES, ticket.priority, (e) => patch({ priority: e.target.value })),
    ),
    block(
      'Device',
      select(
        'device_id',
        [['', '— none —'], ...devices.map((d) => [d.id, d.name])],
        ticket.device_id ?? '',
        (e) => patch({ device_id: e.target.value || null }),
      ),
    ),
    block(
      'Due date',
      el('input', {
        type: 'date',
        value: ticket.due_date ?? '',
        onchange: (e) => patch({ due_date: e.target.value || null }),
      }),
    ),
    el(
      'div',
      { class: 'sidebar-block muted', style: 'font-size: 12px' },
      el('div', {}, `Created ${relativeTime(ticket.created_at)}`),
      el('div', {}, `Updated ${relativeTime(ticket.updated_at)}`),
      ticket.resolved_at && el('div', {}, `Resolved ${relativeTime(ticket.resolved_at)}`),
      ticket.schedule_id &&
        el(
          'div',
          {},
          'From ',
          el('a', { href: `#/schedules/${ticket.schedule_id}` }, 'a maintenance schedule'),
        ),
    ),
    el(
      'button',
      {
        class: 'btn btn-danger btn-sm',
        style: 'width: 100%',
        onclick: guard(async () => {
          if (!confirm(`Delete task #${id}? This cannot be undone.`)) return;
          await api(`/tickets/${id}`, { method: 'DELETE' });
          toast('Task deleted');
          location.hash = '#/all';
        }),
      },
      'Delete task',
    ),
  );
}

/* ---- Ticket modals ------------------------------------------------------ */

async function newTicketModal(presetDeviceId) {
  const devices = await api('/devices').catch(() => []);

  openModal(
    'Add task',
    () =>
      el(
        'div',
        {},
        field('Title', el('input', { name: 'title', required: true, maxlength: 200, placeholder: 'What do you want to remember?' })),
        el('p', { class: 'muted' }, 'Saved to Inbox. You can sort it out later.'),
        el('details', { class: 'capture-details' },
          el('summary', {}, 'Optional details'),
          field(
            'Notes',
            el('textarea', { name: 'body', placeholder: 'Any context, ideas, or next steps…' }),
          ),
          el(
            'div',
            { class: 'field-row' },
            field('Priority', select('priority', PRIORITIES, 'medium')),
            field(
              'Device',
              select(
                'device_id',
                [['', '— none —'], ...devices.map((d) => [d.id, d.name])],
                presetDeviceId ?? '',
              ),
            ),
          ),
          el(
            'div',
            { class: 'field-row' },
            field('Due date', el('input', { name: 'due_date', type: 'date' })),
            field('Tags', el('input', { name: 'tags', placeholder: 'home, tech, personal' })),
          ),
        ),
      ),
    async (data) => {
      const ticket = await api('/tickets', {
        method: 'POST',
        body: {
          title: data.title,
          queue: 'inbox',
          body: data.body,
          priority: data.priority,
          device_id: data.device_id || null,
          due_date: data.due_date || null,
          tags: parseTags(data.tags),
        },
      });
      toast(`Saved to Inbox: ${ticket.title}`);
      await render();
    },
  );
}

function editTicketModal(ticket, patch) {
  openModal(
    `Edit task #${ticket.id}`,
    () =>
      el(
        'div',
        {},
        field('Title', el('input', { name: 'title', required: true, value: ticket.title })),
        field('Description', el('textarea', { name: 'body' }, ticket.body)),
        field(
          'Tags',
          el('input', { name: 'tags', value: ticket.tags.join(', '), placeholder: 'disk, backup' }),
        ),
      ),
    (data) => patch({ title: data.title, body: data.body, tags: parseTags(data.tags) }),
  );
}

/* ---- Devices ------------------------------------------------------------ */

async function renderDevices(view, query) {
  const params = new URLSearchParams(query);
  const devices = await api(`/devices?${params}`);

  const update = (key, value) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    location.hash = `#/devices${next.toString() ? `?${next}` : ''}`;
  };

  const search = searchBox('Search name, hostname, IP, location…', query.q, (q) => update('q', q));

  view.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Devices'),
        el(
          'p',
          {},
          `${devices.length} ${devices.length === 1 ? 'device' : 'devices'}`,
          exportLinks('devices'),
        ),
      ),
      el('button', { class: 'btn btn-primary', onclick: () => deviceModal() }, 'Add device'),
    ),
    el(
      'div',
      { class: 'filters' },
      search,
      select(
        'type',
        [['', 'Any type'], ...DEVICE_TYPES.map((t) => [t, t])],
        query.type,
        (e) => update('type', e.target.value),
      ),
      select(
        'status',
        [['', 'Any status'], ...DEVICE_STATUSES.map((s) => [s, s])],
        query.status,
        (e) => update('status', e.target.value),
      ),
    ),
    devices.length === 0
      ? el(
          'div',
          { class: 'empty-state' },
          el('strong', {}, 'No devices yet'),
          'Add your first server, NAS, or switch to start tracking work against it.',
        )
      : el('div', { class: 'device-grid' }, ...devices.map(deviceCard)),
  );
}

function deviceCard(device) {
  const rows = [
    ['host', device.hostname],
    ['ip', device.ip_address],
    ['os', device.os],
    ['where', device.location],
  ].filter(([, value]) => value);

  return el(
    'div',
    {
      class: 'device-card',
      onclick: () => { location.hash = `#/devices/${device.id}`; },
    },
    el(
      'div',
      { class: 'name' },
      el('span', {}, device.name),
      device.open_tickets > 0
        ? el(
            'span',
            { class: 'badge badge-status', style: '--c: var(--high)' },
            `${device.open_tickets} open`,
          )
        : el('span', { class: 'badge plain muted' }, '✓'),
    ),
    el(
      'div',
      { class: 'sub muted', style: 'font-size: 12px' },
      `${device.type}${device.status !== 'active' ? ` · ${device.status}` : ''}`,
    ),
    rows.length > 0 &&
      el(
        'dl',
        {},
        ...rows.flatMap(([key, value]) => [el('dt', {}, key), el('dd', {}, value)]),
      ),
  );
}

async function renderDeviceDetail(view, id) {
  const [device, tickets] = await Promise.all([
    api(`/devices/${id}`),
    api(`/tickets?device_id=${id}&status=all&sort=updated`),
  ]);

  const open = tickets.filter((t) => t.is_open);
  const history = tickets.filter((t) => !t.is_open);

  const rows = [
    ['Type', device.type],
    ['Status', device.status],
    ['Hostname', device.hostname],
    ['IP address', device.ip_address],
    ['OS', device.os],
    ['Location', device.location],
    ['Serial', device.serial_number],
    ['Purchase date', device.purchase_date],
    ['Warranty', device.warranty_expires],
    ['Cost', device.cost != null ? device.cost : null],
    ['Added', device.created_at?.slice(0, 10)],
  ].filter(([, value]) => value);

  view.append(
    el('a', { class: 'back-link', href: '#/devices' }, '← All devices'),
    el(
      'div',
      { class: 'detail-grid' },
      el(
        'div',
        {},
        el(
          'div',
          { class: 'detail-head row-between' },
          el('h1', {}, device.name),
          el(
            'div',
            { style: 'display: flex; gap: 8px' },
            el(
              'button',
              { class: 'btn btn-sm', onclick: () => newTicketModal(device.id) },
              'Add task',
            ),
            el('button', { class: 'btn btn-sm', onclick: () => deviceModal(device) }, 'Edit'),
          ),
        ),
        topologyCard(device),
        el(
          'section',
          { class: 'card', style: 'margin-bottom: 16px' },
          el('h2', {}, `Open tasks (${open.length})`),
          open.length === 0
            ? el('p', { class: 'muted' }, 'Nothing open against this device.')
            : el('div', { class: 'ticket-list' }, ...open.map((t) => ticketRow(t))),
        ),
        el(
          'section',
          { class: 'card' },
          el('h2', {}, `Service history (${history.length})`),
          history.length === 0
            ? el('p', { class: 'muted' }, 'No resolved tickets yet.')
            : el(
                'ul',
                { class: 'mini-list' },
                ...history.map((t) =>
                  el(
                    'li',
                    {},
                    el('a', { href: `#/tickets/${t.id}` }, t.title),
                    el(
                      'span',
                      { class: 'meta' },
                      t.resolved_at ? relativeTime(t.resolved_at) : label(t.status),
                    ),
                  ),
                ),
              ),
        ),
      ),
      el(
        'aside',
        { class: 'card' },
        el('h2', {}, 'Details'),
        el(
          'dl',
          { style: 'margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 12.5px' },
          ...rows.flatMap(([key, value]) => [
            el('dt', { class: 'muted' }, key),
            el('dd', { style: 'margin: 0; overflow-wrap: anywhere' }, value),
          ]),
        ),
        device.notes &&
          el(
            'div',
            { style: 'margin-top: 14px' },
            el('label', {}, 'Notes'),
            el('div', { class: 'prose', style: 'font-size: 13px' }, renderMarkdown(device.notes)),
          ),
        el(
          'button',
          {
            class: 'btn btn-danger btn-sm',
            style: 'width: 100%; margin-top: 16px',
            onclick: guard(async () => {
              const warning = tickets.length
                ? `Delete ${device.name}? Its ${tickets.length} ticket(s) are kept but unlinked.`
                : `Delete ${device.name}?`;
              if (!confirm(warning)) return;
              await api(`/devices/${id}`, { method: 'DELETE' });
              toast('Device deleted');
              location.hash = '#/devices';
            }),
          },
          'Delete device',
        ),
      ),
    ),
  );
}

/**
 * What this device depends on, and what depends on it — the "if I pull this,
 * what goes with it?" view. Shown only when there is a relationship to draw.
 */
function topologyCard(device) {
  const dependents = device.dependents ?? [];
  if (!device.parent_name && dependents.length === 0) return null;

  return el(
    'section',
    { class: 'card', style: 'margin-bottom: 16px' },
    el('h2', {}, 'Dependencies'),
    device.parent_id &&
      el(
        'p',
        { style: 'margin: 0 0 10px' },
        'Depends on ',
        el('a', { href: `#/devices/${device.parent_id}` }, device.parent_name),
      ),
    dependents.length > 0 &&
      el(
        'div',
        {},
        el('label', {}, `Used by ${dependents.length} device${dependents.length === 1 ? '' : 's'}`),
        el(
          'ul',
          { class: 'mini-list' },
          ...dependents.map((d) =>
            el(
              'li',
              {},
              el('a', { href: `#/devices/${d.id}` }, d.name),
              el(
                'span',
                { class: d.open_tickets > 0 ? 'meta overdue' : 'meta' },
                d.open_tickets > 0 ? `${d.open_tickets} open` : d.type,
              ),
            ),
          ),
        ),
      ),
  );
}

async function deviceModal(device) {
  const editing = Boolean(device);
  // The parent picker needs the roster; exclude the device itself so it cannot
  // be set as its own parent from the dropdown.
  const devices = (await api('/devices').catch(() => [])).filter((d) => d.id !== device?.id);

  openModal(
    editing ? `Edit ${device.name}` : 'Add device',
    () =>
      el(
        'div',
        {},
        field(
          'Name',
          el('input', { name: 'name', required: true, value: device?.name ?? '', placeholder: 'nas-01' }),
        ),
        el(
          'div',
          { class: 'field-row' },
          field('Type', select('type', DEVICE_TYPES, device?.type ?? 'server')),
          field('Status', select('status', DEVICE_STATUSES, device?.status ?? 'active')),
        ),
        el(
          'div',
          { class: 'field-row' },
          field(
            'Hostname',
            el('input', { name: 'hostname', value: device?.hostname ?? '', placeholder: 'nas-01.lan' }),
          ),
          field(
            'IP address',
            el('input', { name: 'ip_address', value: device?.ip_address ?? '', placeholder: '10.0.0.20' }),
          ),
        ),
        el(
          'div',
          { class: 'field-row' },
          field('OS', el('input', { name: 'os', value: device?.os ?? '', placeholder: 'TrueNAS 24' })),
          field(
            'Location',
            el('input', { name: 'location', value: device?.location ?? '', placeholder: 'Rack, shelf 2' }),
          ),
        ),
        el(
          'div',
          { class: 'field-row' },
          field(
            'Serial number',
            el('input', { name: 'serial_number', value: device?.serial_number ?? '', placeholder: 'For the RMA' }),
          ),
          field(
            'Cost',
            el('input', {
              name: 'cost',
              type: 'number',
              min: 0,
              step: '0.01',
              value: device?.cost ?? '',
              placeholder: '0.00',
            }),
          ),
        ),
        el(
          'div',
          { class: 'field-row' },
          field(
            'Purchase date',
            el('input', { name: 'purchase_date', type: 'date', value: device?.purchase_date ?? '' }),
          ),
          field(
            'Warranty expires',
            el('input', { name: 'warranty_expires', type: 'date', value: device?.warranty_expires ?? '' }),
          ),
        ),
        field(
          'Depends on',
          select(
            'parent_id',
            [['', '— nothing —'], ...devices.map((d) => [d.id, d.name])],
            device?.parent_id ?? '',
          ),
        ),
        field('Notes', el('textarea', { name: 'notes' }, device?.notes ?? '')),
      ),
    async (data) => {
      // Empty optional fields come back as '' from the form; send null so they
      // clear the column rather than failing date/number validation.
      const body = {
        ...data,
        cost: data.cost === '' ? null : data.cost,
        purchase_date: data.purchase_date || null,
        warranty_expires: data.warranty_expires || null,
        serial_number: data.serial_number || null,
        parent_id: data.parent_id || null,
      };

      if (editing) {
        await api(`/devices/${device.id}`, { method: 'PATCH', body });
        toast('Device updated');
      } else {
        const created = await api('/devices', { method: 'POST', body });
        toast(`Added ${created.name}`);
      }
      render();
    },
  );
}

/* ---- Schedules ---------------------------------------------------------- */

async function renderSchedules(view, query) {
  const params = new URLSearchParams(query);
  const [schedules, devices] = await Promise.all([
    api(`/schedules?${params}`),
    api('/devices'),
  ]);

  const update = (key, value) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    location.hash = `#/schedules${next.toString() ? `?${next}` : ''}`;
  };

  const runDue = guard(async () => {
    const result = await api('/maintenance/run', { method: 'POST' });
    const count = result.schedules_fired.length;
    toast(count === 0 ? 'Nothing due right now' : `Created ${count} ticket(s)`);
    render();
  });

  view.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Schedules'),
        el(
          'p',
          {},
          `${schedules.length} ${schedules.length === 1 ? 'schedule' : 'schedules'}`,
          exportLinks('schedules'),
          calendarLink(),
        ),
      ),
      el(
        'div',
        { style: 'display: flex; gap: 8px' },
        el('button', { class: 'btn', onclick: runDue }, 'Run due now'),
        el('button', { class: 'btn btn-primary', onclick: () => scheduleModal(null, devices) }, 'New schedule'),
      ),
    ),
    el(
      'div',
      { class: 'filters' },
      select(
        'paused',
        [['', 'All schedules'], ['false', 'Active'], ['true', 'Paused']],
        query.paused,
        (e) => update('paused', e.target.value),
      ),
      select(
        'device_id',
        [['', 'Any device'], ...devices.map((d) => [d.id, d.name])],
        query.device_id,
        (e) => update('device_id', e.target.value),
      ),
    ),
    schedules.length === 0
      ? el(
          'div',
          { class: 'empty-state' },
          el('strong', {}, 'No schedules yet'),
          'Filter changes, cert renewals, battery swaps — the work you only remember once it has already gone wrong.',
        )
      : el('div', { class: 'ticket-list' }, ...schedules.map((s) => scheduleRow(s, devices))),
  );
}

function scheduleRow(schedule, devices) {
  const overdue = !schedule.paused && schedule.due_in_days <= 0;

  const toggle = guard(async (event) => {
    event.stopPropagation();
    await api(`/schedules/${schedule.id}`, {
      method: 'PATCH',
      body: { paused: !schedule.paused },
    });
    toast(schedule.paused ? 'Resumed' : 'Paused');
    render();
  });

  return el(
    'div',
    {
      class: `ticket-row${schedule.paused ? ' done' : ''}`,
      style: `--prio: var(--${schedule.priority})`,
      onclick: () => { location.hash = `#/schedules/${schedule.id}`; },
    },
    el(
      'div',
      { class: 'main' },
      el('div', { class: 'title' }, schedule.title),
      el(
        'div',
        { class: 'sub' },
        el('span', { class: 'id' }, `#${schedule.id}`),
        el('span', { class: 'badge plain' }, cadence(schedule.interval_days)),
        priorityBadge(schedule.priority),
        schedule.device_name && el('span', {}, `· ${schedule.device_name}`),
        el(
          'span',
          { class: overdue ? 'overdue' : '' },
          `· ${schedule.paused ? `paused, next ${schedule.next_due}` : dueDescription(schedule.due_in_days)}`,
        ),
        ...schedule.tags.map((tag) => el('span', { class: 'tag' }, tag)),
      ),
    ),
    el(
      'button',
      { class: 'btn btn-ghost btn-sm', onclick: toggle },
      schedule.paused ? 'Resume' : 'Pause',
    ),
  );
}

async function renderScheduleDetail(view, id) {
  const [schedule, devices] = await Promise.all([api(`/schedules/${id}`), api('/devices')]);

  const rows = [
    ['Cadence', cadence(schedule.interval_days)],
    ['Next due', schedule.next_due],
    ['Status', schedule.paused ? 'Paused' : dueDescription(schedule.due_in_days)],
    ['Opens early', schedule.lead_days > 0 ? `${schedule.lead_days} days ahead` : 'on the due date'],
    ['Device', schedule.device_name],
    ['Priority', label(schedule.priority)],
    ['Last run', schedule.last_run_at ? relativeTime(schedule.last_run_at) : 'never'],
  ].filter(([, value]) => value);

  view.append(
    el('a', { class: 'back-link', href: '#/schedules' }, '← All schedules'),
    el(
      'div',
      { class: 'detail-grid' },
      el(
        'div',
        {},
        el(
          'div',
          { class: 'detail-head row-between' },
          el('h1', {}, schedule.title),
          el(
            'div',
            { style: 'display: flex; gap: 8px' },
            el(
              'button',
              { class: 'btn btn-sm', onclick: () => scheduleModal(schedule, devices) },
              'Edit',
            ),
          ),
        ),
        el(
          'section',
          { class: 'card', style: 'margin-bottom: 16px' },
          el('h2', {}, 'Ticket template'),
          schedule.body
            ? prose(schedule.body)
            : el('div', { class: 'prose empty' }, 'No description.'),
          schedule.tags.length > 0 &&
            el('div', { class: 'badges', style: 'margin-top: 10px' },
              ...schedule.tags.map((tag) => el('span', { class: 'tag' }, tag))),
        ),
        el(
          'section',
          { class: 'card' },
          el('h2', {}, `Tickets generated (${schedule.tickets.length})`),
          schedule.tickets.length === 0
            ? el('p', { class: 'muted' }, 'Nothing generated yet.')
            : el(
                'ul',
                { class: 'mini-list' },
                ...schedule.tickets.map((t) =>
                  el(
                    'li',
                    {},
                    el('a', { href: `#/tickets/${t.id}` }, t.title),
                    el(
                      'span',
                      { class: 'meta' },
                      `${label(t.status)} · due ${t.due_date}`,
                    ),
                  ),
                ),
              ),
        ),
      ),
      el(
        'aside',
        { class: 'card' },
        el('h2', {}, 'Details'),
        el(
          'dl',
          { style: 'margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 12.5px' },
          ...rows.flatMap(([key, value]) => [
            el('dt', { class: 'muted' }, key),
            el('dd', { style: 'margin: 0; overflow-wrap: anywhere' }, value),
          ]),
        ),
        el(
          'button',
          {
            class: 'btn btn-sm',
            style: 'width: 100%; margin-top: 16px',
            onclick: guard(async () => {
              await api(`/schedules/${id}`, { method: 'PATCH', body: { paused: !schedule.paused } });
              render();
            }),
          },
          schedule.paused ? 'Resume schedule' : 'Pause schedule',
        ),
        el(
          'button',
          {
            class: 'btn btn-danger btn-sm',
            style: 'width: 100%; margin-top: 8px',
            onclick: guard(async () => {
              const warning = schedule.tickets.length
                ? `Delete this schedule? Its ${schedule.tickets.length} ticket(s) are kept but unlinked.`
                : 'Delete this schedule?';
              if (!confirm(warning)) return;
              await api(`/schedules/${id}`, { method: 'DELETE' });
              toast('Schedule deleted');
              location.hash = '#/schedules';
            }),
          },
          'Delete schedule',
        ),
      ),
    ),
  );
}

function scheduleModal(schedule, devices) {
  const editing = Boolean(schedule);

  openModal(
    editing ? `Edit schedule #${schedule.id}` : 'New schedule',
    () =>
      el(
        'div',
        {},
        field(
          'Title',
          el('input', {
            name: 'title',
            required: true,
            value: schedule?.title ?? '',
            placeholder: 'Replace NAS dust filters',
          }),
        ),
        field(
          'Description',
          el('textarea', { name: 'body', placeholder: 'What the job involves…' }, schedule?.body ?? ''),
        ),
        el(
          'div',
          { class: 'field-row' },
          field(
            'Every N days',
            el('input', {
              name: 'interval_days',
              type: 'number',
              min: 1,
              max: 3650,
              required: true,
              value: schedule?.interval_days ?? 90,
            }),
          ),
          field(
            'Open this many days early',
            el('input', {
              name: 'lead_days',
              type: 'number',
              min: 0,
              max: 365,
              value: schedule?.lead_days ?? 0,
            }),
          ),
        ),
        el(
          'div',
          { class: 'field-row' },
          field(
            'Next due',
            el('input', {
              name: 'next_due',
              type: 'date',
              value: schedule?.next_due ?? new Date().toISOString().slice(0, 10),
            }),
          ),
          field('Priority', select('priority', PRIORITIES, schedule?.priority ?? 'medium')),
        ),
        el(
          'div',
          { class: 'field-row' },
          field(
            'Device',
            select(
              'device_id',
              [['', '— none —'], ...devices.map((d) => [d.id, d.name])],
              schedule?.device_id ?? '',
            ),
          ),
          field(
            'Tags',
            el('input', {
              name: 'tags',
              value: schedule?.tags.join(', ') ?? '',
              placeholder: 'maintenance',
            }),
          ),
        ),
      ),
    async (data) => {
      const body = {
        title: data.title,
        body: data.body,
        priority: data.priority,
        device_id: data.device_id || null,
        interval_days: Number(data.interval_days),
        lead_days: Number(data.lead_days || 0),
        next_due: data.next_due || null,
        tags: parseTags(data.tags),
      };

      if (editing) {
        await api(`/schedules/${schedule.id}`, { method: 'PATCH', body });
        toast('Schedule updated');
      } else {
        const created = await api('/schedules', { method: 'POST', body });
        toast(`Created schedule #${created.id}`);
      }
      render();
    },
  );
}

/* ---- Export ------------------------------------------------------------- */

/** Plain links, so the browser downloads with the session cookie attached. */
function exportLinks(entity) {
  return el(
    'span',
    { class: 'export-links' },
    '· export ',
    el('a', { href: `/api/export?entity=${entity}&format=csv` }, 'CSV'),
    ' ',
    el('a', { href: `/api/export?entity=${entity}&format=json` }, 'JSON'),
  );
}

/** Link to the iCalendar feed of due dates and maintenance. */
function calendarLink() {
  return el(
    'span',
    { class: 'export-links' },
    '· ',
    el(
      'a',
      { href: '/api/calendar.ics', title: 'Subscribe from a calendar app using ?token=API_TOKEN' },
      'calendar feed',
    ),
  );
}

/* ---- Keyboard ----------------------------------------------------------- */

const SHORTCUTS = [
  ['n', 'Add task to Inbox'],
  ['/', 'Focus search'],
  ['g then d', 'Go to dashboard'],
  ['g then t', 'Go to all tasks'],
  ['g then i', 'Go to Inbox'],
  ['g then v', 'Go to devices'],
  ['g then s', 'Go to schedules'],
  ['?', 'This help'],
  ['Esc', 'Close dialog'],
];

const GO_TO = { d: '#/dashboard', t: '#/all', i: '#/', v: '#/devices', s: '#/schedules' };

/** True while focus is somewhere that swallows plain keystrokes. */
function isTyping() {
  const active = document.activeElement;
  return (
    active?.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName)
  );
}

function showShortcuts() {
  const root = document.getElementById('modal-root');
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const panel = el(
    'div',
    { class: 'modal' },
    el('h2', {}, 'Keyboard shortcuts'),
    el(
      'dl',
      { class: 'shortcut-list' },
      ...SHORTCUTS.flatMap(([keys, description]) => [
        el('dt', {}, ...keys.split(' then ').flatMap((key, i) => (i === 0 ? [el('kbd', {}, key)] : [' then ', el('kbd', {}, key)]))),
        el('dd', {}, description),
      ]),
    ),
    el(
      'div',
      { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn btn-primary', onclick: close }, 'Close'),
    ),
  );

  const backdrop = el('div', { class: 'modal-backdrop' }, panel);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);

  root.innerHTML = '';
  root.append(backdrop);
}

function installShortcuts() {
  let awaitingGo = false;
  let goTimer;

  document.addEventListener('keydown', (event) => {
    // Modifier combinations belong to the browser, and anything typed into a
    // field is text rather than a command.
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping() || document.getElementById('modal-root').childElementCount) return;

    if (awaitingGo) {
      clearTimeout(goTimer);
      awaitingGo = false;
      const target = GO_TO[event.key];
      if (target) {
        event.preventDefault();
        location.hash = target;
      }
      return;
    }

    switch (event.key) {
      case 'g':
        awaitingGo = true;
        // A stranded 'g' should not silently capture the next keystroke.
        goTimer = setTimeout(() => { awaitingGo = false; }, 1500);
        break;
      case 'n':
        event.preventDefault();
        newTicketModal();
        break;
      case '/': {
        const search = document.querySelector('.search');
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
        }
        break;
      }
      case '?':
        event.preventDefault();
        showShortcuts();
        break;
      default:
        break;
    }
  });
}

/* ---- Router ------------------------------------------------------------- */

const ROUTES = [
  [/^\/?$/, (view, query) => renderTickets(view, query, 'inbox'), 'inbox'],
  [/^\/next$/, (view, query) => renderTickets(view, query, 'next'), 'next'],
  [/^\/someday$/, (view, query) => renderTickets(view, query, 'someday'), 'someday'],
  [/^\/done$/, (view, query) => renderTickets(view, query, 'done'), 'done'],
  [/^\/all$/, (view, query) => renderTickets(view, query, 'all'), 'all'],
  [/^\/dashboard$/, renderDashboard, 'dashboard'],
  [/^\/tickets\/(\d+)$/, renderTicketDetail, 'tickets'],
  [/^\/tickets$/, renderTickets, 'tickets'],
  [/^\/devices\/(\d+)$/, renderDeviceDetail, 'devices'],
  [/^\/devices$/, renderDevices, 'devices'],
  [/^\/schedules\/(\d+)$/, renderScheduleDetail, 'schedules'],
  [/^\/schedules$/, renderSchedules, 'schedules'],
];

let renderVersion = 0;
async function render() {
  const version = ++renderVersion;
  clearViewTimers();
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, queryString = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryString));

  const view = document.getElementById('view');
  const match = ROUTES.map(([re, handler, tab]) => [re.exec(path), handler, tab]).find(
    ([result]) => result,
  );

  for (const link of document.querySelectorAll('nav [data-tab]')) {
    link.classList.toggle('active', link.dataset.tab === (match?.[2] ?? ''));
  }

  const next = document.createElement('main');
  next.id = 'view';

  try {
    if (!match) {
      next.append(
        el('div', { class: 'empty-state' }, el('strong', {}, 'Page not found'), raw),
      );
    } else {
      const [result, handler] = match;
      // Detail routes take an id; list routes take the parsed query string.
      await handler(next, result[1] ? Number(result[1]) : query);
    }
  } catch (err) {
    next.append(
      el('div', { class: 'empty-state' }, el('strong', {}, 'Could not load'), err.message),
    );
  }

  if (version === renderVersion) {
    next.setAttribute('aria-live', 'polite');
    view.replaceWith(next);
  }
}

/* ---- Session ------------------------------------------------------------ */

/** Reveals the sign-out control only when a password is actually in force. */
async function initSession() {
  const button = document.getElementById('sign-out');
  const session = await api('/auth/session').catch(() => null);
  if (!session?.enabled) return;

  button.hidden = false;
  button.addEventListener(
    'click',
    guard(async () => {
      await api('/auth/logout', { method: 'POST' });
      location.replace('/login');
    }),
  );
}

window.addEventListener('hashchange', render);
document.getElementById('new-ticket').addEventListener('click', () => newTicketModal());
document.getElementById('shortcuts').addEventListener('click', showShortcuts);
installShortcuts();
initSession();
render();

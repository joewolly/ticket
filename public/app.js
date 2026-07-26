/* Homelab ticket system — single-page client, no build step, no dependencies. */

const TICKET_STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const DEVICE_TYPES = [
  'server', 'nas', 'network', 'vm', 'container-host',
  'iot', 'workstation', 'peripheral', 'other',
];
const DEVICE_STATUSES = ['active', 'spare', 'retired'];

const LABELS = {
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
    { name, onchange },
    ...options.map((opt) => {
      const [val, text] = Array.isArray(opt) ? opt : [opt, label(opt)];
      return el('option', { value: val, selected: String(val) === String(value ?? '') }, text);
    }),
  );
}

function field(labelText, control) {
  return el('div', { class: 'field' }, el('label', {}, labelText), control);
}

function toast(message, isError = false) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = isError ? 'show error' : 'show';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = ''; }, 2600);
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

/* ---- Modal -------------------------------------------------------------- */

function openModal(title, buildBody, onSubmit) {
  const root = document.getElementById('modal-root');
  const form = el('form', { class: 'modal' });
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

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
    const data = Object.fromEntries(new FormData(form));
    try {
      await onSubmit(data);
      close();
    } catch (err) {
      toast(err.message, true);
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
      stat(stats.open_tickets, 'Open tickets'),
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

async function renderTickets(view, query) {
  const params = new URLSearchParams(query);
  const [tickets, devices, tags] = await Promise.all([
    api(`/tickets?${params}`),
    api('/devices'),
    api('/tags'),
  ]);

  const update = (key, value) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    location.hash = `#/tickets${next.toString() ? `?${next}` : ''}`;
  };

  const search = el('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Search title and description…',
    value: query.q ?? '',
  });
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => update('q', search.value.trim()), 250);
  });

  view.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Tickets'),
        el('p', {}, `${tickets.length} ${tickets.length === 1 ? 'ticket' : 'tickets'}`),
      ),
      el('button', { class: 'btn btn-primary', onclick: () => newTicketModal() }, 'New ticket'),
    ),
    el(
      'div',
      { class: 'filters' },
      search,
      select(
        'status',
        [['active', 'Active'], ['all', 'All statuses'], ...TICKET_STATUSES.map((s) => [s, label(s)])],
        query.status ?? 'active',
        (e) => update('status', e.target.value === 'active' ? '' : e.target.value),
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
        ],
        query.sort ?? 'priority',
        (e) => update('sort', e.target.value),
      ),
    ),
    tickets.length === 0
      ? el(
          'div',
          { class: 'empty-state' },
          el('strong', {}, 'No tickets match'),
          'Adjust the filters, or create a ticket.',
        )
      : el('div', { class: 'ticket-list' }, ...tickets.map(ticketRow)),
  );
}

function ticketRow(ticket) {
  return el(
    'div',
    {
      class: `ticket-row${ticket.is_open ? '' : ' done'}`,
      style: `--prio: var(--${ticket.priority})`,
      onclick: () => { location.hash = `#/tickets/${ticket.id}`; },
    },
    el(
      'div',
      { class: 'main' },
      el('div', { class: 'title' }, ticket.title),
      el(
        'div',
        { class: 'sub' },
        el('span', { class: 'id' }, `#${ticket.id}`),
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
  );
}

/* ---- Ticket detail ------------------------------------------------------ */

async function renderTicketDetail(view, id) {
  const [ticket, devices] = await Promise.all([api(`/tickets/${id}`), api('/devices')]);

  const patch = guard(async (changes) => {
    await api(`/tickets/${id}`, { method: 'PATCH', body: changes });
    toast('Ticket updated');
    render();
  });

  view.append(
    el('a', { class: 'back-link', href: '#/tickets' }, '← All tickets'),
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
            ...ticket.tags.map((tag) => el('a', { class: 'tag', href: `#/tickets?tag=${tag}` }, tag)),
          ),
        ),
        el(
          'section',
          { class: 'card', style: 'margin-bottom: 16px' },
          el('h2', {}, 'Description'),
          el(
            'div',
            { class: ticket.body ? 'prose' : 'prose empty' },
            ticket.body || 'No description.',
          ),
        ),
        commentsCard(ticket, id),
      ),
      ticketSidebar(ticket, devices, patch, id),
    ),
  );
}

function commentsCard(ticket, id) {
  const input = el('textarea', {
    name: 'body',
    placeholder: 'Add a note — what you tried, what fixed it…',
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

  return el(
    'section',
    { class: 'card' },
    el('h2', {}, `Activity (${ticket.comments.length})`),
    ...ticket.comments.map((comment) =>
      el(
        'div',
        { class: 'comment' },
        el(
          'div',
          { class: 'comment-head' },
          el('span', {}, relativeTime(comment.created_at)),
          el(
            'button',
            {
              class: 'btn btn-ghost btn-sm delete',
              onclick: guard(async () => {
                await api(`/tickets/${id}/comments/${comment.id}`, { method: 'DELETE' });
                render();
              }),
            },
            'Delete',
          ),
        ),
        el('div', { class: 'prose' }, comment.body),
      ),
    ),
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

function ticketSidebar(ticket, devices, patch, id) {
  const block = (labelText, control) =>
    el('div', { class: 'sidebar-block' }, el('label', {}, labelText), control);

  return el(
    'aside',
    { class: 'card' },
    block(
      'Status',
      select('status', TICKET_STATUSES, ticket.status, (e) => patch({ status: e.target.value })),
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
    ),
    el(
      'button',
      {
        class: 'btn btn-danger btn-sm',
        style: 'width: 100%',
        onclick: guard(async () => {
          if (!confirm(`Delete ticket #${id}? This cannot be undone.`)) return;
          await api(`/tickets/${id}`, { method: 'DELETE' });
          toast('Ticket deleted');
          location.hash = '#/tickets';
        }),
      },
      'Delete ticket',
    ),
  );
}

/* ---- Ticket modals ------------------------------------------------------ */

async function newTicketModal(presetDeviceId) {
  const devices = await api('/devices').catch(() => []);

  openModal(
    'New ticket',
    () =>
      el(
        'div',
        {},
        field('Title', el('input', { name: 'title', required: true, placeholder: 'What is wrong?' })),
        field(
          'Description',
          el('textarea', { name: 'body', placeholder: 'Symptoms, logs, what you already tried…' }),
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
          field('Tags', el('input', { name: 'tags', placeholder: 'disk, backup' })),
        ),
      ),
    async (data) => {
      const ticket = await api('/tickets', {
        method: 'POST',
        body: {
          title: data.title,
          body: data.body,
          priority: data.priority,
          device_id: data.device_id || null,
          due_date: data.due_date || null,
          tags: parseTags(data.tags),
        },
      });
      toast(`Created ticket #${ticket.id}`);
      location.hash = `#/tickets/${ticket.id}`;
      render();
    },
  );
}

function editTicketModal(ticket, patch) {
  openModal(
    `Edit ticket #${ticket.id}`,
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

  const search = el('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Search name, hostname, IP, location…',
    value: query.q ?? '',
  });
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => update('q', search.value.trim()), 250);
  });

  view.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Devices'),
        el('p', {}, `${devices.length} ${devices.length === 1 ? 'device' : 'devices'}`),
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
              'New ticket',
            ),
            el('button', { class: 'btn btn-sm', onclick: () => deviceModal(device) }, 'Edit'),
          ),
        ),
        el(
          'section',
          { class: 'card', style: 'margin-bottom: 16px' },
          el('h2', {}, `Open tickets (${open.length})`),
          open.length === 0
            ? el('p', { class: 'muted' }, 'Nothing open against this device.')
            : el('div', { class: 'ticket-list' }, ...open.map(ticketRow)),
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
            el('div', { class: 'prose', style: 'font-size: 13px' }, device.notes),
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

function deviceModal(device) {
  const editing = Boolean(device);

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
        field('Notes', el('textarea', { name: 'notes' }, device?.notes ?? '')),
      ),
    async (data) => {
      if (editing) {
        await api(`/devices/${device.id}`, { method: 'PATCH', body: data });
        toast('Device updated');
      } else {
        const created = await api('/devices', { method: 'POST', body: data });
        toast(`Added ${created.name}`);
      }
      render();
    },
  );
}

/* ---- Router ------------------------------------------------------------- */

const ROUTES = [
  [/^\/?$/, renderDashboard, 'dashboard'],
  [/^\/tickets\/(\d+)$/, renderTicketDetail, 'tickets'],
  [/^\/tickets$/, renderTickets, 'tickets'],
  [/^\/devices\/(\d+)$/, renderDeviceDetail, 'devices'],
  [/^\/devices$/, renderDevices, 'devices'],
];

async function render() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, queryString = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryString));

  const view = document.getElementById('view');
  const match = ROUTES.map(([re, handler, tab]) => [re.exec(path), handler, tab]).find(
    ([result]) => result,
  );

  for (const link of document.querySelectorAll('.tabs a')) {
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

  view.replaceWith(next);
}

window.addEventListener('hashchange', render);
document.getElementById('new-ticket').addEventListener('click', () => newTicketModal());
render();

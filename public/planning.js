/* Planning UI uses the existing DOM helpers and API, without a framework or build step. */
let ui;
export let planningDate = new Date().toISOString().slice(0, 10);
export function setupPlanning(context) {
  ui = context;
}
const button = (text, action, primary = false) =>
  ui.el(
    'button',
    {
      type: 'button',
      class: `btn${primary ? ' btn-primary' : ' btn-sm'}`,
      onclick: ui.guard(async (event) => {
        event.stopPropagation();
        await action(event);
      }),
    },
    text,
  );
const heading = (title, description, ...actions) =>
  ui.el(
    'div',
    { class: 'page-head' },
    ui.el('div', {}, ui.el('h1', {}, title), ui.el('p', {}, description)),
    ui.el('div', { class: 'planning-actions' }, ...actions),
  );
const empty = (text) =>
  ui.el('div', { class: 'empty-state' }, ui.el('strong', {}, text));
const patch = async (id, body) => {
  await ui.api(`/tickets/${id}`, { method: 'PATCH', body });
  await ui.render();
};
const dayPlus = (days) => {
  const d = new Date(planningDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function refreshPlanning() {
  const { today } = await ui.api('/planning');
  planningDate = today;
  const nav = document.getElementById('saved-views-nav');
  if (nav) {
    const views = await ui.api('/views');
    nav.replaceChildren(
      ...views.map((v) => ui.el('a', { href: `#/views/${v.id}` }, v.name)),
    );
  }
}

export function planningBadges(t) {
  return [
    t.today_rank !== null &&
      ui.el('span', { class: 'badge focus-badge' }, 'Today'),
    t.project_name && ui.el('span', { class: 'tag' }, t.project_name),
    t.checklist_total > 0 &&
      ui.el('span', {}, `${t.checklist_completed}/${t.checklist_total} steps`),
    t.waiting_on &&
      ui.el(
        'span',
        { class: 'badge' },
        `Waiting: ${t.waiting_on}${t.follow_up_date ? ` · ${t.follow_up_date}` : ''}`,
      ),
    t.snoozed_until > planningDate &&
      ui.el('span', { class: 'badge' }, `Snoozed until ${t.snoozed_until}`),
  ];
}

export function snoozeModal(ticket) {
  const { el, field, openModal } = ui;
  const date = el('input', {
    type: 'date',
    name: 'snoozed_until',
    required: true,
    value: ticket.snoozed_until || dayPlus(1),
  });
  const weekday = new Date(planningDate + 'T12:00:00Z').getUTCDay();
  openModal(
    'Snooze task',
    () =>
      el(
        'div',
        {},
        el(
          'p',
          { class: 'muted' },
          'Your deadline stays in place. The task returns to its list on this date.',
        ),
        el(
          'div',
          { class: 'planning-actions' },
          button('Tomorrow', () => {
            date.value = dayPlus(1);
          }),
          button('Next Monday', () => {
            date.value = dayPlus((8 - weekday) % 7 || 7);
          }),
        ),
        field('Bring back on', date),
      ),
    async (data) => patch(ticket.id, data),
  );
}

function waitingModal(ticket) {
  const { el, field, openModal } = ui;
  openModal(
    'Waiting on',
    () =>
      el(
        'div',
        {},
        field(
          'Person, delivery, or reason',
          el('input', {
            name: 'waiting_on',
            required: true,
            maxlength: 500,
            value: ticket.waiting_on || '',
            placeholder: 'Replacement part from supplier',
          }),
        ),
        field(
          'Follow up on (optional)',
          el('input', {
            name: 'follow_up_date',
            type: 'date',
            value: ticket.follow_up_date || '',
          }),
        ),
      ),
    async (data) => patch(ticket.id, data),
  );
}

export async function planningCard(ticket) {
  const { el, select, field } = ui;
  const projects = await ui.api('/projects');
  return el(
    'section',
    { class: 'card planning-card' },
    el('h2', {}, 'Plan this task'),
    field(
      'Project',
      select(
        'project_id',
        [
          ['', 'No project'],
          ...projects
            .filter((p) => !p.archived || p.id === ticket.project_id)
            .map((p) => [p.id, p.name]),
        ],
        ticket.project_id,
        ui.guard((event) =>
          patch(ticket.id, { project_id: event.target.value || null }),
        ),
      ),
    ),
    ticket.is_open &&
      el(
        'div',
        { class: 'planning-actions' },
        button(
          ticket.today_rank !== null ? 'Remove from Today' : 'Add to Today',
          () => patch(ticket.id, { today: ticket.today_rank === null }),
        ),
        button('Snooze…', () => snoozeModal(ticket)),
        button('Waiting on…', () => waitingModal(ticket)),
        ticket.snoozed_until &&
          button('Unsnooze', () => patch(ticket.id, { snoozed_until: null })),
        ticket.waiting_on &&
          button('Clear waiting', () => patch(ticket.id, { waiting_on: null })),
      ),
    el('div', { class: 'planning-badges' }, ...planningBadges(ticket)),
    !ticket.schedule_id &&
      button('Make recurring…', () => recurrenceModal(ticket)),
    ticket.schedule_id &&
      el(
        'a',
        { class: 'back-link', href: `#/schedules/${ticket.schedule_id}` },
        'View recurring schedule',
      ),
  );
}

export function checklistCard(ticket) {
  const { el, api, field, openModal } = ui;
  const items = ticket.checklist || [];
  const change = async (path, method, body) => {
    await api(`/tickets/${ticket.id}/checklist${path}`, { method, body });
    await ui.render();
  };
  const reorder = async (index, delta) => {
    const ids = items.map((i) => i.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    await change('/order', 'PUT', { ids });
  };
  const input = el('input', {
    name: 'checklist_title',
    placeholder: 'Add a step…',
    maxlength: 500,
    required: true,
    'aria-label': 'New checklist item',
  });
  return el(
    'section',
    { class: 'card planning-card' },
    el(
      'h2',
      {},
      `Checklist · ${ticket.checklist_completed}/${ticket.checklist_total}`,
    ),
    el(
      'ul',
      { class: 'checklist' },
      ...items.map((item, index) =>
        el(
          'li',
          {},
          el(
            'label',
            { class: item.completed ? 'check-complete' : '' },
            el('input', {
              type: 'checkbox',
              checked: Boolean(item.completed),
              onchange: ui.guard((e) =>
                change(`/${item.id}`, 'PATCH', { completed: e.target.checked }),
              ),
            }),
            item.title,
          ),
          el(
            'div',
            { class: 'planning-actions' },
            index > 0 && button('↑', () => reorder(index, -1)),
            index < items.length - 1 && button('↓', () => reorder(index, 1)),
            button('Edit', () =>
              openModal(
                'Edit step',
                () =>
                  field(
                    'Step',
                    el('input', {
                      name: 'title',
                      value: item.title,
                      required: true,
                      maxlength: 500,
                    }),
                  ),
                (data) => change(`/${item.id}`, 'PATCH', data),
              ),
            ),
            button('Remove', () => change(`/${item.id}`, 'DELETE')),
          ),
        ),
      ),
    ),
    el(
      'form',
      {
        class: 'planning-actions',
        onsubmit: ui.guard(async (event) => {
          event.preventDefault();
          await change('', 'POST', { title: input.value });
        }),
      },
      input,
      el('button', { class: 'btn', type: 'submit' }, 'Add step'),
    ),
  );
}

function taskRows(tasks) {
  const { el, ticketRow } = ui;
  return tasks.length
    ? el(
        'div',
        { class: 'ticket-list' },
        ...tasks.map((t) =>
          el(
            'div',
            { class: 'planning-task' },
            ticketRow(t),
            t.is_open &&
              el(
                'div',
                { class: 'planning-actions' },
                button(
                  t.today_rank !== null ? 'Remove from Today' : 'Add to Today',
                  () => patch(t.id, { today: t.today_rank === null }),
                ),
                button('Mark Done', () => patch(t.id, { status: 'resolved' })),
                button('Snooze…', () => snoozeModal(t)),
                t.snoozed_until &&
                  button('Unsnooze', () =>
                    patch(t.id, { snoozed_until: null }),
                  ),
                t.waiting_on &&
                  button('Clear waiting', () =>
                    patch(t.id, { waiting_on: null }),
                  ),
              ),
          ),
        ),
      )
    : empty('Nothing here yet');
}

async function renderToday(view) {
  const { el, api } = ui;
  const tasks = await api('/tickets?today=true&sort=today');
  const due = await api('/tickets?due=week&sort=due');
  const overdue = await api('/tickets?due=overdue&sort=due');
  view.append(
    heading(
      'Today',
      'A small, intentional list. Unfinished tasks stay here until you finish or remove them.',
      el('a', { class: 'btn', href: '#/next' }, 'Choose from Next'),
    ),
  );
  const move = async (from, to) => {
    const ids = tasks.map((t) => t.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    await api('/tickets/today/order', { method: 'PUT', body: { ids } });
    await ui.render();
  };
  let dragIndex = null;
  const list = el(
    'div',
    { class: 'focus-list' },
    ...tasks.map((task, index) =>
      el(
        'section',
        {
          class: 'focus-task',
          draggable: 'true',
          ondragstart: (e) => {
            dragIndex = index;
            e.dataTransfer.setData('text/plain', String(index));
          },
          ondragover: (e) => e.preventDefault(),
          ondrop: ui.guard(async (e) => {
            e.preventDefault();
            if (dragIndex !== null && dragIndex !== index)
              await move(dragIndex, index);
          }),
          ondragend: () => {
            dragIndex = null;
          },
        },
        el(
          'span',
          { class: 'focus-number' },
          String(index + 1).padStart(2, '0'),
        ),
        el('div', { class: 'focus-content' }, ui.ticketRow(task)),
        el(
          'div',
          { class: 'planning-actions' },
          index > 0 && button('Move up', () => move(index, index - 1)),
          index < tasks.length - 1 &&
            button('Move down', () => move(index, index + 1)),
          button('Done', () => patch(task.id, { status: 'resolved' }), true),
          button('Remove', () => patch(task.id, { today: false })),
        ),
      ),
    ),
  );
  view.append(
    tasks.length ? list : empty('Choose a few tasks for today'),
    el(
      'section',
      { class: 'deadline-section' },
      heading(
        'Deadlines',
        'Overdue and coming up in the next seven days. These do not change your Today selections.',
      ),
      taskRows([...overdue, ...due]),
    ),
  );
}

async function renderDeferred(view, kind) {
  view.append(
    heading(
      kind === 'waiting' ? 'Waiting' : 'Snoozed',
      kind === 'waiting'
        ? 'Keep track of what needs a response. Dated follow-ups return to your working list.'
        : 'Out of the way until you are ready. Explicit deadlines still count.',
    ),
  );
  view.append(taskRows(await ui.api(`/tickets?${kind}=true&sort=due`)));
}

function projectModal(project) {
  const { el, field, openModal } = ui;
  openModal(
    project ? 'Edit project' : 'New project',
    () =>
      el(
        'div',
        {},
        field(
          'Name',
          el('input', {
            name: 'name',
            required: true,
            maxlength: 200,
            value: project?.name || '',
          }),
        ),
        field(
          'Notes',
          el('textarea', { name: 'notes', rows: 5 }, project?.notes || ''),
        ),
      ),
    async (body) => {
      const result = await ui.api(
        `/projects${project ? '/' + project.id : ''}`,
        { method: project ? 'PATCH' : 'POST', body },
      );
      location.hash = `#/projects/${result.id}`;
      await ui.render();
    },
  );
}

async function renderProjects(view) {
  const { el, api } = ui;
  const projects = await api('/projects');
  view.append(
    heading(
      'Projects',
      'A home for the tasks that belong together.',
      button('New project', () => projectModal(), true),
    ),
  );
  view.append(
    el(
      'div',
      { class: 'project-grid' },
      ...projects.map((p) =>
        el(
          'a',
          {
            class: `card project-card${p.archived ? ' archived' : ''}`,
            href: `#/projects/${p.id}`,
          },
          el('span', { class: 'muted' }, p.archived ? 'ARCHIVED' : 'PROJECT'),
          el('h2', {}, p.name),
          el('p', {}, `${p.completed} of ${p.total} tasks complete`),
          el('progress', {
            max: Math.max(1, p.total),
            value: p.completed,
            'aria-label': `${p.name} progress`,
          }),
          el(
            'p',
            { class: 'muted' },
            p.next_action
              ? `Next: ${p.next_action.title}`
              : 'No next action selected',
          ),
        ),
      ),
    ),
  );
  if (!projects.length) view.append(empty('Create your first project'));
}

async function renderProject(view, id) {
  const { el, api } = ui,
    p = await api(`/projects/${id}`);
  view.append(
    el('a', { class: 'back-link', href: '#/projects' }, '← Projects'),
    heading(
      p.name,
      `${p.completed}/${p.total} complete${p.archived ? ' · Archived' : ''}`,
      button('Edit project', () => projectModal(p)),
      button(p.archived ? 'Unarchive' : 'Archive', async () => {
        await api(`/projects/${id}`, {
          method: 'PATCH',
          body: { archived: !p.archived },
        });
        await ui.render();
      }),
      button('Delete', async () => {
        if (
          !confirm('Delete this project? Tasks and their history will be kept.')
        )
          return;
        await api(`/projects/${id}`, { method: 'DELETE' });
        location.hash = '#/projects';
      }),
    ),
    p.notes &&
      el('section', { class: 'card planning-card' }, ui.prose(p.notes)),
    p.next_action &&
      el(
        'div',
        { class: 'next-action' },
        el('span', { class: 'muted' }, 'NEXT ACTION'),
        el('a', { href: `#/tickets/${p.next_action.id}` }, p.next_action.title),
      ),
    el(
      'div',
      { class: 'planning-actions' },
      el(
        'a',
        { class: 'btn btn-primary', href: `#/capture?project_id=${id}` },
        'Add task to project',
      ),
      button('Assign existing task', async () => {
        const tasks = await api('/tickets?status=all');
        ui.openModal(
          'Assign task',
          () =>
            ui.field(
              'Task',
              ui.select(
                'task_id',
                tasks
                  .filter((t) => t.project_id !== Number(id))
                  .map((t) => [t.id, t.title]),
                '',
              ),
            ),
          async (data) => patch(data.task_id, { project_id: id }),
        );
      }),
    ),
    taskRows(p.tickets),
  );
}

export function saveCurrentView(filters) {
  return viewModal(null, filters);
}
async function viewModal(saved, preset = {}) {
  const { el, api, field, select, openModal } = ui;
  const projects = await api('/projects'),
    devices = await api('/devices');
  const values = saved?.filters || preset;
  openModal(
    saved ? 'Edit saved view' : 'Save view',
    () =>
      el(
        'div',
        {},
        field(
          'Name',
          el('input', {
            name: 'name',
            value: saved?.name || '',
            required: true,
            maxlength: 100,
          }),
        ),
        el(
          'div',
          { class: 'filter-editor' },
          field(
            'Search within this view',
            el('input', { name: 'q', value: values.q || '' }),
          ),
          field(
            'List',
            select(
              'queue',
              [
                ['', 'Any list'],
                ['inbox', 'Inbox'],
                ['next', 'Next'],
                ['someday', 'Someday'],
              ],
              values.queue,
            ),
          ),
          field(
            'Progress',
            select(
              'status',
              [
                ['active', 'Active'],
                ['all', 'All'],
                ['done', 'Done'],
                ['open', 'Open'],
                ['in_progress', 'In progress'],
                ['blocked', 'Blocked'],
              ],
              values.status || 'active',
            ),
          ),
          field(
            'Priority',
            select(
              'priority',
              [
                ['', 'Any'],
                ...['low', 'medium', 'high', 'critical'].map((p) => [p, p]),
              ],
              values.priority,
            ),
          ),
          field(
            'Project',
            select(
              'project_id',
              [['', 'Any project'], ...projects.map((p) => [p.id, p.name])],
              values.project_id,
            ),
          ),
          field(
            'Device',
            select(
              'device_id',
              [['', 'Any device'], ...devices.map((p) => [p.id, p.name])],
              values.device_id,
            ),
          ),
          field('Tag', el('input', { name: 'tag', value: values.tag || '' })),
          field(
            'Due',
            select(
              'due',
              [
                ['', 'Any date'],
                ['today', 'Today'],
                ['overdue', 'Overdue'],
                ['week', 'Next seven days'],
                ['none', 'No deadline'],
              ],
              values.due,
            ),
          ),
          ...['today', 'waiting', 'snoozed', 'actionable'].map((key) =>
            field(
              key[0].toUpperCase() + key.slice(1),
              select(
                key,
                [
                  ['', 'Any'],
                  ['true', 'Yes'],
                ],
                values[key],
              ),
            ),
          ),
          field(
            'Sort',
            select(
              'sort',
              [
                'priority',
                'newest',
                'oldest',
                'updated',
                'due',
                'completed',
                'today',
              ],
              values.sort || 'priority',
            ),
          ),
        ),
      ),
    async (data) => {
      const { name, ...filters } = data;
      Object.keys(filters).forEach((key) => {
        if (!filters[key]) delete filters[key];
      });
      const result = await api(`/views${saved ? '/' + saved.id : ''}`, {
        method: saved ? 'PATCH' : 'POST',
        body: { name, filters },
      });
      location.hash = `#/views/${result.id}`;
      await ui.render();
    },
  );
}

async function renderViews(view) {
  const { el, api } = ui,
    views = await api('/views');
  const reorder = async (index, delta) => {
    const ids = views.map((v) => v.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    await api('/views/order', { method: 'PUT', body: { ids } });
    await ui.render();
  };
  view.append(
    heading(
      'Saved views',
      'Your filters, ready whenever you need them.',
      button('New view', () => viewModal(), true),
    ),
    ...views.map((v, i) =>
      el(
        'section',
        { class: 'card planning-card row-between' },
        el('a', { href: `#/views/${v.id}` }, v.name),
        el(
          'div',
          { class: 'planning-actions' },
          button('Edit', () => viewModal(v)),
          i > 0 && button('Move up', () => reorder(i, -1)),
          i < views.length - 1 && button('Move down', () => reorder(i, 1)),
        ),
      ),
    ),
  );
}

async function renderSavedView(view, id) {
  const saved = await ui.api(`/views/${id}`);
  view.append(
    heading(
      saved.name,
      'Tasks matching your saved filters.',
      button('Edit filters', () => viewModal(saved)),
      button('Delete view', async () => {
        if (!confirm('Delete this saved view?')) return;
        await ui.api(`/views/${id}`, { method: 'DELETE' });
        location.hash = '#/views';
      }),
    ),
    taskRows(await ui.api(`/tickets?${new URLSearchParams(saved.filters)}`)),
  );
}

const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
export function recurrenceLabel(schedule) {
  const r = schedule.recurrence;
  if (!r) return `Every ${schedule.interval_days} days`;
  if (r.kind === 'weekly') return r.weekdays.map((d) => DAYS[d]).join(', ');
  if (r.kind === 'monthly_date') return `Monthly on day ${r.day}`;
  if (r.kind === 'monthly_weekday')
    return `${['First', 'Second', 'Third', 'Fourth', 'Last'][r.ordinal - 1]} ${DAYS[r.weekday]} each month`;
  return r.kind === 'after_completion'
    ? `${r.days} days after completion`
    : `Every ${r.days} days`;
}

export async function recurrenceModal(ticket = null, schedule = null) {
  const { el, api, field, select, openModal } = ui;
  const projects = await api('/projects'),
    devices = await api('/devices'),
    source = schedule || ticket || {};
  const rule = schedule?.recurrence || {
    kind: 'weekly',
    weekdays: [1, 2, 3, 4, 5],
  };
  const kind = select(
    'kind',
    [
      ['weekly', 'Selected weekdays'],
      ['monthly_date', 'Monthly date'],
      ['monthly_weekday', 'Weekday of the month'],
      ['interval', 'Every N days'],
      ['after_completion', 'N days after completion'],
    ],
    rule.kind,
  );
  const options = el('div');
  const draw = () => {
    options.replaceChildren();
    if (kind.value === 'weekly')
      options.append(
        el(
          'fieldset',
          { class: 'weekday-picker' },
          el('legend', {}, 'Repeat on'),
          ...DAYS.map((day, i) =>
            el(
              'label',
              {},
              el('input', {
                type: 'checkbox',
                name: `weekday_${i}`,
                checked: rule.weekdays?.includes(i),
              }),
              day,
            ),
          ),
        ),
      );
    else if (kind.value === 'monthly_date')
      options.append(
        field(
          'Day of month (short months use their last day)',
          el('input', {
            type: 'number',
            name: 'day',
            min: 1,
            max: 31,
            value: rule.day || 1,
            required: true,
          }),
        ),
      );
    else if (kind.value === 'monthly_weekday')
      options.append(
        field(
          'Which week',
          select(
            'ordinal',
            [
              [1, 'First'],
              [2, 'Second'],
              [3, 'Third'],
              [4, 'Fourth'],
              [5, 'Last'],
            ],
            rule.ordinal || 1,
          ),
        ),
        field(
          'Weekday',
          select(
            'weekday',
            DAYS.map((d, i) => [i, d]),
            rule.weekday || 0,
          ),
        ),
      );
    else
      options.append(
        field(
          'Number of days',
          el('input', {
            type: 'number',
            name: 'days',
            min: 1,
            max: 3650,
            value: rule.days || 30,
            required: true,
          }),
        ),
      );
  };
  kind.addEventListener('change', draw);
  draw();
  openModal(
    schedule ? 'Edit routine' : 'New routine',
    () =>
      el(
        'div',
        {},
        field(
          'Title',
          el('input', {
            name: 'title',
            value: source.title || '',
            required: true,
            maxlength: 200,
          }),
        ),
        field(
          'Notes',
          el('textarea', { name: 'body', rows: 3 }, source.body || ''),
        ),
        field('Repeat', kind),
        options,
        field(
          'Start on',
          el('input', {
            type: 'date',
            name: 'next_due',
            value: source.next_due || source.due_date || planningDate,
            required: true,
          }),
        ),
        field(
          'Project',
          select(
            'project_id',
            [['', 'No project'], ...projects.map((p) => [p.id, p.name])],
            source.project_id,
          ),
        ),
        field(
          'Device',
          select(
            'device_id',
            [['', 'No device'], ...devices.map((p) => [p.id, p.name])],
            source.device_id,
          ),
        ),
        field(
          'Priority',
          select(
            'priority',
            ['low', 'medium', 'high', 'critical'],
            source.priority || 'medium',
          ),
        ),
        field(
          'Tags',
          el('input', { name: 'tags', value: (source.tags || []).join(', ') }),
        ),
        field(
          'Checklist template (one step per line)',
          el(
            'textarea',
            { name: 'checklist', rows: 4 },
            (
              schedule?.checklist ||
              ticket?.checklist?.map((i) => i.title) ||
              []
            ).join('\n'),
          ),
        ),
        el(
          'p',
          { class: 'muted' },
          'One unfinished task at a time. Deadlines stay visible until you complete the work.',
        ),
      ),
    async (data) => {
      const recurrence =
        data.kind === 'weekly'
          ? {
              kind: data.kind,
              weekdays: DAYS.map((_, i) => i).filter(
                (i) => data[`weekday_${i}`],
              ),
            }
          : data.kind === 'monthly_date'
            ? { kind: data.kind, day: Number(data.day) }
            : data.kind === 'monthly_weekday'
              ? {
                  kind: data.kind,
                  ordinal: Number(data.ordinal),
                  weekday: Number(data.weekday),
                }
              : { kind: data.kind, days: Number(data.days) };
      const body = {
        title: data.title,
        body: data.body,
        priority: data.priority,
        tags: data.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        next_due: data.next_due,
        project_id: data.project_id || null,
        device_id: data.device_id || null,
        recurrence,
        checklist: data.checklist
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      };
      if (ticket) body.source_ticket_id = ticket.id;
      const result = await api(
        `/schedules${schedule ? '/' + schedule.id : ''}`,
        { method: schedule ? 'PATCH' : 'POST', body },
      );
      location.hash = `#/schedules/${result.id}`;
      await ui.render();
    },
  );
}

export const planningRoutes = [
  [/^\/today$/, renderToday, 'today'],
  [/^\/waiting$/, (view) => renderDeferred(view, 'waiting'), 'waiting'],
  [/^\/snoozed$/, (view) => renderDeferred(view, 'snoozed'), 'snoozed'],
  [/^\/projects\/(\d+)$/, renderProject, 'projects'],
  [/^\/projects$/, renderProjects, 'projects'],
  [/^\/views\/(\d+)$/, renderSavedView, 'views'],
  [/^\/views$/, renderViews, 'views'],
];

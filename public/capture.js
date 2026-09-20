import {
  listDrafts,
  getDraft,
  putDraft,
  deleteDraft,
  clearDrafts,
} from './draft-store.js';
let ui;
export let pendingCaptureHash = null;
export function setupCapture(context) {
  ui = context;
}
export { clearDrafts };
const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
};
const uid = () => crypto.randomUUID();
function fileType(file) {
  const type = (file.type || '').split(';')[0].toLowerCase();
  return !type ||
    ['application/octet-stream', 'binary/octet-stream'].includes(type)
    ? TYPES[file.name.split('.').pop().toLowerCase()]
    : type;
}
async function response(res) {
  if (res.status === 401)
    throw Object.assign(
      new Error(
        'Sign in, then return to Drafts to finish submitting. Your draft is safe on this device.',
      ),
      { status: 401 },
    );
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(
      new Error(data.error || `Request failed (${res.status})`),
      { status: res.status },
    );
  return data;
}

export async function renderCapture(view, query = {}) {
  const { el, field, select, guard } = ui;
  view.classList.add('capture-page');
  let draft = query.draft ? await getDraft(query.draft) : null;
  if (query.draft && !draft) {
    view.append(
      el('h1', {}, 'Draft no longer available'),
      el('a', { href: '#/drafts' }, 'Return to drafts'),
    );
    return;
  }
  const fresh = !draft;
  if (!draft)
    draft = {
      id: uid(),
      title: (query.title || '').slice(0, 200),
      body: [query.text, query.url]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 20000),
      project_id: query.project_id || null,
      device_id: query.device_id || null,
      tags: '',
      priority: 'medium',
      due_date: '',
      files: [],
      updated_at: new Date().toISOString(),
    };
  if (fresh) {
    try {
      await putDraft(draft);
    } catch {
      throw new Error(
        'This device could not save a draft. Remove old items from Drafts or free some storage, then try again.',
      );
    }
    // Strip shared text from history once it is saved. Fragments never reach the server.
    history.replaceState(
      null,
      '',
      `${location.pathname}${location.search}#/capture?draft=${draft.id}`,
    );
  }
  let saving = Promise.resolve(),
    busy = false;
  const status = el(
    'p',
    { class: 'capture-status', role: 'status', 'aria-live': 'polite' },
    'Saved on this device',
  );
  const tell = (text, error = false) => {
    status.textContent = text;
    status.className = `capture-status${error ? ' error' : ''}`;
  };
  const persist = () => {
    draft.updated_at = new Date().toISOString();
    const snapshot = structuredClone(draft);
    saving = saving.catch(() => {}).then(() => putDraft(snapshot));
    saving.then(
      () =>
        tell(
          navigator.onLine
            ? 'Draft saved on this device'
            : 'Offline · draft saved on this device',
        ),
      () =>
        tell(
          'Could not save on this device. Keep this page open and free some storage before continuing.',
          true,
        ),
    );
    return saving;
  };
  const fields = el('fieldset', { class: 'capture-fields' });
  const bind = (name, control) => {
    control.addEventListener('input', () => {
      draft[name] = control.value;
      persist();
    });
    return field(
      name === 'body'
        ? 'Notes'
        : name === 'due_date'
          ? 'Deadline (optional)'
          : name === 'title'
            ? 'Task'
            : name[0].toUpperCase() + name.slice(1),
      control,
    );
  };
  fields.append(
    bind(
      'title',
      el('input', {
        name: 'title',
        class: 'capture-title',
        placeholder: 'What do you want to remember?',
        maxlength: 200,
        required: true,
        value: draft.title,
      }),
    ),
    bind(
      'body',
      el(
        'textarea',
        {
          name: 'body',
          placeholder: 'A little context for later…',
          maxlength: 20000,
        },
        draft.body,
      ),
    ),
    el(
      'details',
      {},
      el('summary', {}, 'Optional details'),
      bind(
        'priority',
        select(
          'priority',
          ['low', 'medium', 'high', 'critical'],
          draft.priority,
        ),
      ),
      bind(
        'tags',
        el('input', {
          name: 'tags',
          value: draft.tags || '',
          placeholder: 'home, tech, personal',
        }),
      ),
      bind(
        'due_date',
        el('input', {
          name: 'due_date',
          type: 'date',
          value: draft.due_date || '',
        }),
      ),
    ),
  );
  const optional = fields.querySelector('details');
  // Choices are helpful online, but an unavailable server must never block capture.
  const loadChoices = async () => {
    try {
      const results = await Promise.all(
        ['/projects', '/devices'].map((path) =>
          fetch('/api' + path).then(response),
        ),
      );
      if (
        !view.isConnected &&
        !fields.isConnected &&
        document.getElementById('view')?.dataset.captureId !== draft.id
      )
        return;
      [
        ['project_id', 'Project', results[0]],
        ['device_id', 'Device', results[1]],
      ].forEach(([key, label, items]) => {
        const missing =
          draft[key] &&
          !items.some((item) => String(item.id) === String(draft[key]));
        const input = select(
          key,
          [
            ['', `No ${label.toLowerCase()}`],
            ...(missing
              ? [
                  [
                    draft[key],
                    `Unavailable ${label.toLowerCase()} — choose another`,
                  ],
                ]
              : []),
            ...items.map((item) => [item.id, item.name]),
          ],
          draft[key],
        );
        input.addEventListener('change', () => {
          draft[key] = input.value || null;
          persist();
        });
        optional.append(field(label, input));
      });
      fields.disabled = Boolean(draft.payload) || busy;
    } catch {
      /* A draft's existing assignment remains intact offline. */
    }
  };
  view.dataset.captureId = draft.id;
  const files = el('ul', { class: 'draft-files' });
  const drawFiles = () =>
    files.replaceChildren(
      ...draft.files.map((file) =>
        el(
          'li',
          {},
          el(
            'div',
            {},
            file.name,
            el(
              'div',
              { class: 'draft-meta' },
              `${Math.ceil(file.size / 1024)} KB · ${file.uploaded ? 'Attached' : 'Saved locally'}`,
            ),
          ),
          !file.uploaded &&
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm',
                disabled: busy,
                onclick: guard(async () => {
                  draft.files = draft.files.filter((f) => f.id !== file.id);
                  await persist();
                  drawFiles();
                }),
              },
              'Remove',
            ),
        ),
      ),
    );
  const picker = el('input', {
    type: 'file',
    multiple: true,
    accept: Object.keys(TYPES)
      .map((t) => '.' + t)
      .join(','),
    'aria-label': 'Choose attachments',
  });
  picker.addEventListener(
    'change',
    guard(async () => {
      if (busy) return;
      busy = true;
      pendingCaptureHash = location.hash;
      unlock();
      try {
        const rejected = [];
        for (const file of picker.files) {
          const type = fileType(file);
          if (!Object.values(TYPES).includes(type)) {
            rejected.push(`${file.name}: unsupported type`);
            continue;
          }
          if (file.size === 0 || file.size > 1024 * 1024) {
            rejected.push(
              `${file.name}: choose a file between 1 byte and 1 MB`,
            );
            continue;
          }
          // ArrayBuffers also work in WebKit environments that cannot persist File handles.
          draft.files.push({
            id: uid(),
            name: file.name,
            type,
            bytes: await file.arrayBuffer(),
            size: file.size,
            uploaded: false,
          });
        }
        picker.value = '';
        await persist();
        drawFiles();
        if (rejected.length) tell(rejected.join('. '), true);
      } finally {
        busy = false;
        pendingCaptureHash = null;
        unlock();
      }
    }),
  );
  const submit = el(
    'button',
    { type: 'submit', class: 'btn btn-primary' },
    draft.payload ? 'Resume submission' : 'Save to Inbox',
  );
  const unlock = () => {
    fields.disabled = Boolean(draft.payload) || busy;
    picker.disabled = busy;
    submit.disabled = busy;
    submit.textContent = draft.payload ? 'Resume submission' : 'Save to Inbox';
    drawFiles();
  };
  const signIn = el(
    'a',
    {
      class: 'btn',
      href: '/login',
      onclick: () =>
        sessionStorage.setItem(
          'taskhub-return',
          `/capture.html#/capture?draft=${draft.id}`,
        ),
    },
    'Sign in',
  );
  const discard = el(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm',
      onclick: guard(async () => {
        if (busy) return;
        if (
          !confirm(
            draft.ticket_id
              ? 'Discard remaining uploads? The saved task will be kept.'
              : 'Discard this local draft?',
          )
        )
          return;
        await saving;
        await deleteDraft(draft.id);
        location.hash = '#/drafts';
      }),
    },
    'Discard draft',
  );
  const form = el(
    'form',
    {
      onsubmit: guard(async (event) => {
        event.preventDefault();
        if (busy) return;
        busy = true;
        pendingCaptureHash = location.hash;
        unlock();
        try {
          await saving;
          if (!draft.title.trim()) throw new Error('Give your task a title.');
          if (!navigator.onLine)
            throw new Error(
              'Offline. Your draft is saved; submit when connected.',
            );
          if (!draft.payload) {
            draft.payload = {
              title: draft.title,
              body: draft.body,
              queue: 'inbox',
              priority: draft.priority,
              due_date: draft.due_date || null,
              tags: (draft.tags || '')
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
              project_id: draft.project_id || null,
              device_id: draft.device_id || null,
            };
            await persist();
          }
          tell('Saving task…');
          if (!draft.ticket_id) {
            const ticket = await fetch('/api/tickets', {
              method: 'POST',
              signal: AbortSignal.timeout(15000),
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': draft.id,
              },
              body: JSON.stringify(draft.payload),
            }).then(response);
            draft.ticket_id = ticket.id;
            await persist();
          }
          for (const file of draft.files.filter((f) => !f.uploaded)) {
            tell(`Task saved. Attaching ${file.name}…`);
            await fetch(`/api/tickets/${draft.ticket_id}/attachments`, {
              method: 'POST',
              signal: AbortSignal.timeout(15000),
              headers: {
                'Content-Type': file.type,
                'X-Filename': encodeURIComponent(file.name),
                'Idempotency-Key': file.id,
              },
              body: file.bytes,
            }).then(response);
            file.uploaded = true;
            await persist();
          }
          await deleteDraft(draft.id);
          tell('Saved to Inbox');
          pendingCaptureHash = null;
          location.href = `/#/tickets/${draft.ticket_id}`;
        } catch (error) {
          if (error.status === 401) signIn.hidden = false;
          if (error.status === 400 && !draft.ticket_id) {
            draft.payload = null;
            await persist();
          }
          tell(
            error.message ||
              'Connection lost. Your draft is saved; retry when connected.',
            true,
          );
        } finally {
          busy = false;
          pendingCaptureHash = null;
          unlock();
        }
      }),
    },
    fields,
    el(
      'section',
      { class: 'planning-card' },
      el('h2', {}, 'Attachments'),
      el(
        'p',
        { class: 'muted' },
        'PNG, JPG, GIF, WebP, PDF or text · up to 1 MB each',
      ),
      picker,
      files,
    ),
    status,
    el(
      'div',
      { class: 'planning-actions capture-footer' },
      submit,
      el('a', { class: 'btn', href: '#/drafts' }, 'View drafts'),
      signIn,
      discard,
    ),
  );
  view.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Capture a task'),
        el('p', {}, 'Write it down now. Sort it out later.'),
      ),
    ),
    el(
      'p',
      { class: 'draft-notice' },
      'Drafts are stored on this device until submitted. They are not part of your server backup.',
    ),
    form,
    el(
      'details',
      { class: 'card planning-card' },
      el('summary', {}, 'Use Task Hub on iPhone'),
      el(
        'p',
        {},
        'In Safari, open Share → Add to Home Screen → Open as Web App. For sharing links or text, create an Apple Shortcut with Show in Share Sheet enabled, URL-encode Shortcut Input, then Open URLs:',
      ),
      el(
        'code',
        {},
        `${location.origin}/capture.html#/capture?text=[URL Encoded Input]`,
      ),
      el(
        'p',
        {},
        'Use the same private HTTPS address every time. Attach photos or files inside the capture screen.',
      ),
    ),
  );
  unlock();
  drawFiles();
  loadChoices();
  fetch('/api/auth/session')
    .then((res) => {
      signIn.hidden = res.ok;
    })
    .catch(() => {});
}

export async function renderDrafts(view) {
  const { el, guard } = ui;
  const drafts = (await listDrafts()).sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
  view.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Drafts'),
        el('p', {}, 'Saved on this device. Submit when connected.'),
      ),
      el('a', { class: 'btn btn-primary', href: '#/capture' }, 'New draft'),
    ),
    ...drafts.map((draft) =>
      el(
        'section',
        { class: 'card planning-card' },
        el(
          'a',
          { href: `#/capture?draft=${draft.id}` },
          el('h2', {}, draft.title || 'Untitled draft'),
        ),
        el(
          'p',
          { class: 'muted' },
          `${draft.files.length} files · ${draft.ticket_id ? 'Task saved; uploads pending' : draft.payload ? 'Submission started; safe to retry' : 'Not submitted'}`,
        ),
        el(
          'div',
          { class: 'planning-actions' },
          el(
            'a',
            { class: 'btn', href: `#/capture?draft=${draft.id}` },
            'Continue',
          ),
          el(
            'button',
            {
              class: 'btn btn-sm',
              onclick: guard(async () => {
                if (
                  !confirm('Discard this local draft? Any saved task is kept.')
                )
                  return;
                await deleteDraft(draft.id);
                await ui.render();
              }),
            },
            'Discard',
          ),
        ),
      ),
    ),
  );
  if (!drafts.length)
    view.append(el('div', { class: 'empty-state' }, 'No local drafts.'));
}

export const captureRoutes = [
  [/^\/capture$/, renderCapture, 'capture'],
  [/^\/drafts$/, renderDrafts, 'drafts'],
];

window.addEventListener('beforeunload', (event) => {
  if (pendingCaptureHash) {
    event.preventDefault();
    event.returnValue = '';
  }
});

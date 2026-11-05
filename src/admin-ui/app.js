// Smittenz Admin — vanilla JS single-page app. No build step, no framework:
// this file is loaded directly by index.html and renders everything itself.
'use strict';

const API = '/admin/api';

/* ------------------------------------------------------------------ */
/* Tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */

function h(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) el.setAttribute(k, v);
    }
  }
  for (const child of children || []) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function searchIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
}

let toastTimer = null;
function showToast(message, kind) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = kind || '';
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ------------------------------------------------------------------ */
/* API client                                                          */
/* ------------------------------------------------------------------ */

async function api(path, options) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    state.authed = false;
    render();
    throw new Error('Session expired — please sign in again');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* App state                                                           */
/* ------------------------------------------------------------------ */

const state = {
  authed: null, // null = unknown yet, true/false once checked
  adminConfigured: true,
  models: [], // [{ key, label, pluralLabel, fields, titleField }]
  counts: {}, // key -> count
  highlights: null,
  view: 'dashboard', // 'dashboard' | modelKey
  // per-model list state
  listState: {}, // key -> { page, pageSize, search, sortField, sortDir }
  listData: {}, // key -> { rows, total, totalPages }
  loadingList: false,
  drawer: null, // { modelKey, row, relations, editing, draft }
  confirm: null, // { message, onConfirm }
};

function listStateFor(modelKey) {
  if (!state.listState[modelKey]) {
    const model = state.models.find((m) => m.key === modelKey);
    state.listState[modelKey] = {
      page: 1,
      pageSize: 25,
      search: '',
      sortField: model ? model.fields.find((f) => f.inList)?.key : undefined,
      sortDir: 'desc',
    };
  }
  return state.listState[modelKey];
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  try {
    const sess = await fetch(`${API}/session`).then((r) => r.json());
    state.adminConfigured = sess.configured;
    if (!sess.configured) {
      state.authed = false;
      render();
      return;
    }
  } catch {
    state.adminConfigured = true; // assume configured, let login attempt surface the real error
  }

  try {
    const data = await api('/models');
    state.models = data.models;
    state.authed = true;
    await loadDashboard();
  } catch {
    state.authed = false;
  }
  render();
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const confirmOverlay = document.querySelector('.confirm-overlay');
  if (confirmOverlay) {
    confirmOverlay.remove();
    return;
  }
  if (state.drawer) closeDetail();
});

window.addEventListener('error', (event) => {
  showBootError(event.message || 'Unknown admin UI error');
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason || 'Unknown admin UI error');
  showBootError(reason);
});

function showBootError(message) {
  const root = document.getElementById('app');
  if (!root) return;
  clear(root);
  root.appendChild(
    h('div', { class: 'login-screen' }, [
      h('div', { class: 'login-card' }, [
        h('div', { class: 'login-mark' }, [
        h('img', { class: 'login-logo', src: '/admin/smittenz-logo.png', alt: 'Smittenz' }),
      ]),
        h('p', { class: 'tagline' }, ['Admin could not load.']),
        h('div', { class: 'login-error' }, [message || 'Unknown admin UI error']),
        h('button', { class: 'btn btn-primary', onclick: () => window.location.reload() }, ['Reload']),
      ]),
    ]),
  );
}

async function loadDashboard() {
  try {
    const stats = await api('/stats');
    state.highlights = stats.highlights;
    for (const c of stats.counts) state.counts[c.key] = c.count;
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Login screen                                                        */
/* ------------------------------------------------------------------ */

function renderLogin(root) {
  let errorMsg = '';

  function submit(e) {
    e.preventDefault();
    const form = e.target;
    const username = form.username.value.trim();
    const password = form.password.value;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    fetch(`${API}/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Sign in failed');
        return boot();
      })
      .catch((err) => {
        errorMsg = err.message;
        draw();
      });
  }

  function draw() {
    clear(root);
    const card = h('div', { class: 'login-card' }, [
      h('div', { class: 'login-mark' }, [
        h('img', { class: 'login-logo', src: '/admin/smittenz-logo.png', alt: 'Smittenz' }),
      ]),
      h('p', { class: 'tagline' }, ['Admin — database access for the team']),
      !state.adminConfigured
        ? h('div', { class: 'login-disabled' }, [
            'Admin panel isn\u2019t configured yet. Set ',
            h('code', null, ['ADMIN_PASSWORD']),
            ' (and optionally ',
            h('code', null, ['ADMIN_USERNAME']),
            ') in the backend ',
            h('code', null, ['.env']),
            ', then restart the server.',
          ])
        : h('form', { onsubmit: submit }, [
            errorMsg ? h('div', { class: 'login-error' }, [errorMsg]) : null,
            h('label', null, ['Username']),
            h('input', { name: 'username', type: 'text', autocomplete: 'username', value: 'admin', required: 'true' }),
            h('label', null, ['Password']),
            h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: 'true' }),
            h('button', { class: 'btn btn-primary', type: 'submit' }, ['Sign in']),
          ]),
    ]);
    root.appendChild(h('div', { class: 'login-screen' }, [card]));
  }

  draw();
}

/* ------------------------------------------------------------------ */
/* Shell: sidebar + topbar                                             */
/* ------------------------------------------------------------------ */

function renderShell(root) {
  clear(root);

  const navItems = state.models.map((m) => {
    const active = state.view === m.key;
    const item = h(
      'li',
      { class: `nav-item${active ? ' active' : ''}` },
      [
        h('button', { onclick: () => goTo(m.key) }, [
          h('span', null, [m.pluralLabel]),
          h('span', { class: 'nav-count' }, [state.counts[m.key] != null ? String(state.counts[m.key]) : '']),
        ]),
      ],
    );
    return item;
  });

  const sidebar = h('div', { class: 'sidebar' }, [
    h('button', { class: 'brand brand-button', onclick: () => goTo('dashboard') }, [
      h('img', { class: 'brand-logo', src: '/admin/smittenz-logo.png', alt: 'Smittenz' }),
      h('span', { class: 'brand-text' }, [
        h('span', { class: 'brand-suffix' }, ['Admin panel']),
      ]),
    ]),
    h('div', { class: 'nav-section-label' }, ['Overview']),
    h('ul', { class: 'nav-list nav-list-overview' }, [
      h(
        'li',
        { class: `nav-item${state.view === 'dashboard' ? ' active' : ''}` },
        [h('button', { onclick: () => goTo('dashboard') }, [
          h('span', null, ['Dashboard']),
          h('span', { class: 'nav-count' }, ['Home']),
        ])],
      ),
    ]),
    h('div', { class: 'nav-section-label' }, ['Data']),
    h('ul', { class: 'nav-list' }, navItems),
    h('div', { class: 'sidebar-foot' }, [
      h('span', { class: 'who' }, ['Signed in']),
      h('button', { class: 'linklike', onclick: logout }, ['Sign out']),
    ]),
  ]);

  const main = h('div', { class: 'main' }, [
    h('div', { id: 'topbar-slot' }),
    h('div', { class: 'content', id: 'content-slot' }),
  ]);

  root.appendChild(h('div', { id: 'app-inner' }, [sidebar, main]));

  if (state.view === 'dashboard') renderDashboardView();
  else renderModelView(state.view);
}

function logout() {
  fetch(`${API}/logout`, { method: 'POST', credentials: 'include' }).finally(() => {
    state.authed = false;
    render();
  });
}

function goTo(view) {
  state.view = view;
  render();
}

/* ------------------------------------------------------------------ */
/* Dashboard view                                                      */
/* ------------------------------------------------------------------ */

function renderDashboardView() {
  const topbar = document.getElementById('topbar-slot');
  clear(topbar);
  topbar.appendChild(
    h('div', { class: 'topbar' }, [
      h('div', { class: 'page-heading' }, [
        h('h1', null, ['Dashboard']),
        h('span', { class: 'topbar-context' }, ['Smittenz admin']),
      ]),
      h('span', { class: 'admin-status' }, ['Admin workspace']),
    ]),
  );

  const content = document.getElementById('content-slot');
  clear(content);

  content.appendChild(h('section', { class: 'dashboard-intro' }, [
    h('div', null, [
      h('span', { class: 'dashboard-kicker' }, ['SMITTENZ ADMIN']),
      h('h2', null, ['Your workspace, at a glance']),
      h('p', null, ['A clear overview of your platform. Choose any collection below to manage its records.']),
    ]),
    h('img', { class: 'intro-decoration', src: '/admin/smittenz-logo.png', alt: 'Smittenz' }),
  ]));

  if (state.highlights) {
    const hl = state.highlights;
    content.appendChild(
      h('div', { class: 'highlight-row' }, [
        h('button', { class: 'highlight-card', onclick: () => goTo('couple'), 'aria-label': `Open couples, ${hl.activeCouples} active` }, [
          h('span', { class: 'highlight-icon couples' }, ['C']),
          h('div', { class: 'highlight-info' }, [
            h('div', { class: 'highlight-num' }, [String(hl.activeCouples)]),
            h('div', { class: 'highlight-label' }, ['Active couples']),
          ]),
        ]),
        h('button', { class: 'highlight-card', onclick: () => goTo('subscription'), 'aria-label': `Open subscriptions, ${hl.activeSubscriptions} active` }, [
          h('span', { class: 'highlight-icon subscriptions' }, ['S']),
          h('div', { class: 'highlight-info' }, [
            h('div', { class: 'highlight-num' }, [String(hl.activeSubscriptions)]),
            h('div', { class: 'highlight-label' }, ['Active subscriptions']),
          ]),
        ]),
        h('button', { class: 'highlight-card', onclick: () => goTo('payment'), 'aria-label': `Open payments, ${hl.completedPayments} completed` }, [
          h('span', { class: 'highlight-icon payments' }, ['P']),
          h('div', { class: 'highlight-info' }, [
            h('div', { class: 'highlight-num' }, [String(hl.completedPayments)]),
            h('div', { class: 'highlight-label' }, ['Completed payments']),
          ]),
        ]),
      ]),
    );
  }

  content.appendChild(h('div', { class: 'dashboard-section-heading' }, [
    h('div', null, [
      h('h2', null, ['Manage your data']),
      h('p', null, ['Select a collection to search, edit, or remove records.']),
    ]),
    h('span', { class: 'collection-count' }, [`${state.models.length} collections`]),
  ]));

  const modelDescriptions = {
    user: 'Profiles, account details, and partner links',
    couple: 'Invite codes, linked partners, and relationship status',
    subscription: 'Plans, access status, and expiry dates',
    payment: 'Payment records and transaction status',
    memory: 'Shared moments and milestone records',
    note: 'Private notes and journal entries',
  };
  const grid = h('div', { class: 'stat-grid' });
  for (const m of state.models) {
    grid.appendChild(
      h('button', { class: 'stat-card', onclick: () => goTo(m.key), 'aria-label': `Manage ${m.pluralLabel}` }, [
        h('span', { class: 'stat-card-topline' }, [
          h('span', { class: 'stat-icon' }, [m.pluralLabel.charAt(0)]),
          h('span', { class: 'stat-arrow', 'aria-hidden': 'true' }, ['\u2197']),
        ]),
        h('span', { class: 'num' }, [state.counts[m.key] != null ? String(state.counts[m.key]) : '\u2014']),
        h('span', { class: 'label' }, [m.pluralLabel]),
        h('span', { class: 'stat-description' }, [modelDescriptions[m.key] || `Browse and manage ${m.pluralLabel.toLowerCase()}`]),
        h('span', { class: 'stat-card-action' }, ['Open collection', h('span', { 'aria-hidden': 'true' }, ['\u2192'])]),
      ]),
    );
  }
  content.appendChild(grid);
}

/* ------------------------------------------------------------------ */
/* Model list view                                                     */
/* ------------------------------------------------------------------ */

function modelDef(key) {
  return state.models.find((m) => m.key === key);
}

function renderModelView(key) {
  const model = modelDef(key);
  if (!model) {
    state.view = 'dashboard';
    renderDashboardView();
    return;
  }
  const ls = listStateFor(key);

  const topbar = document.getElementById('topbar-slot');
  clear(topbar);

  let searchTimer = null;
  let searchClearButton;
  let searchBox;
  const searchInput = h('input', {
    type: 'text',
    placeholder: `Search ${model.pluralLabel.toLowerCase()}\u2026`,
    value: ls.search,
    'aria-label': `Search ${model.pluralLabel.toLowerCase()}`,
    oninput: (e) => {
      clearTimeout(searchTimer);
      const val = e.target.value;
      searchBox.classList.toggle('has-value', Boolean(val));
      searchClearButton.hidden = !val;
      searchTimer = setTimeout(() => {
        ls.search = val;
        ls.page = 1;
        loadAndRenderList(key);
      }, 280);
    },
  });
  searchClearButton = h('button', {
    class: 'search-clear',
    type: 'button',
    hidden: ls.search ? undefined : 'true',
    'aria-label': 'Clear search',
    onclick: () => {
      ls.search = '';
      ls.page = 1;
      renderModelView(key);
    },
  }, ['\u00d7']);
  searchBox = h('div', { class: `search-box${ls.search ? ' has-value' : ''}` }, [
    h('span', { html: searchIconSvg() }),
    searchInput,
    searchClearButton,
  ]);

  const hasSearchable = model.fields.some((f) => f.searchable);

  topbar.appendChild(
    h('div', { class: 'topbar' }, [
      h('div', { class: 'page-heading' }, [
        h('div', null, [
          h('h1', null, [model.pluralLabel]),
          h('div', { class: 'sub' }, [`${state.counts[key] != null ? state.counts[key] : '\u2014'} total records`]),
        ]),
      ]),
      h('div', { class: 'toolbar' }, [
        h('span', { class: 'admin-status' }, ['Admin workspace']),
        hasSearchable ? searchBox : null,
        model.fields.some((f) => f.creatable)
          ? h('button', { class: 'btn btn-primary', onclick: () => openCreate(model.key) }, [`+ Add ${model.label}`])
          : null,
      ]),
    ]),
  );

  const content = document.getElementById('content-slot');
  clear(content);
  content.appendChild(h('div', { class: 'center-loader', id: 'list-loader' }, [h('span', { class: 'spinner' })]));

  loadAndRenderList(key);
}

async function loadAndRenderList(key) {
  const model = modelDef(key);
  const ls = listStateFor(key);
  const content = document.getElementById('content-slot');
  if (!content) return; // user navigated away before this resolved

  try {
    const params = new URLSearchParams({
      page: String(ls.page),
      pageSize: String(ls.pageSize),
    });
    if (ls.search) params.set('search', ls.search);
    if (ls.sortField) params.set('sortField', ls.sortField);
    if (ls.sortDir) params.set('sortDir', ls.sortDir);

    const data = await api(`/models/${key}?${params.toString()}`);
    if (ls.page > data.totalPages) {
      ls.page = data.totalPages;
      return loadAndRenderList(key);
    }
    state.listData[key] = data;
    state.counts[key] = data.total;
    if (state.view === key) renderListTable(key);
  } catch (err) {
    if (state.view !== key) return;
    clear(content);
    content.appendChild(h('div', { class: 'empty-state' }, [err.message]));
  }
}

function renderListTable(key) {
  const model = modelDef(key);
  const ls = listStateFor(key);
  const data = state.listData[key];
  const content = document.getElementById('content-slot');
  clear(content);

  const listFields = model.fields.filter((f) => f.inList);

  if (!data || data.rows.length === 0) {
    content.appendChild(
      h('div', { class: 'empty-state' }, [
        h('div', { class: 'empty-icon' }, [data && data.total === 0 ? '+' : '0']),
        h('h2', null, [data && data.total === 0 && ls.search ? 'No matching records' : `No ${model.pluralLabel.toLowerCase()} yet`]),
        h('p', null, [data && data.total === 0 && ls.search
          ? `Try a different search or clear your current search.`
          : `Records you add will appear here.`]),
        ls.search
          ? h('button', {
              class: 'btn btn-ghost',
              onclick: () => {
                ls.search = '';
                ls.page = 1;
                renderModelView(key);
              },
            }, ['Clear search'])
          : model.fields.some((f) => f.creatable)
            ? h('button', { class: 'btn btn-primary', onclick: () => openCreate(key) }, [`Add ${model.label}`])
            : null,
      ]),
    );
    return;
  }

  const thead = h(
    'tr',
    null,
    [
      ...listFields.map((f) => {
      const isSorted = ls.sortField === f.key;
      return h('th', { onclick: f.virtual ? undefined : () => toggleSort(key, f.key) }, [
        f.label,
        isSorted ? h('span', { class: 'sort-arrow' }, [ls.sortDir === 'asc' ? '\u2191' : '\u2193']) : null,
      ]);
      }),
      h('th', { class: 'actions-heading' }, ['Actions']),
    ],
  );

  const tbody = h(
    'tbody',
    null,
    data.rows.map((row) =>
      h(
        'tr',
        { onclick: () => openDetail(key, row.id) },
        [
          ...listFields.map((f) => h('td', null, [renderCellContent(f, row[f.key])])),
          h('td', { class: 'row-actions', onclick: (e) => e.stopPropagation() }, [
            h('button', {
              class: 'row-action',
              type: 'button',
              onclick: () => openDetail(key, row.id),
              'aria-label': `View ${String(row[model.titleField] ?? model.label)}`,
            }, ['View']),
            model.fields.some((f) => f.editable)
              ? h('button', {
                  class: 'row-action',
                  type: 'button',
                  onclick: () => openDetail(key, row.id, true),
                  'aria-label': `Edit ${String(row[model.titleField] ?? model.label)}`,
                }, ['Edit'])
              : null,
            h('button', {
              class: 'row-action danger',
              type: 'button',
              onclick: () => confirmDelete(key, row),
              'aria-label': `Delete ${String(row[model.titleField] ?? model.label)}`,
            }, ['Delete']),
          ]),
        ],
      ),
    ),
  );

  const table = h('table', null, [h('thead', null, [thead]), tbody]);
  const pageSize = h('select', { class: 'page-size', 'aria-label': 'Rows per page' }, [
    ...[10, 25, 50, 100].map((size) => h('option', { value: String(size) }, [`${size} per page`])),
  ]);
  pageSize.value = String(ls.pageSize);
  pageSize.addEventListener('change', () => {
    ls.pageSize = Number(pageSize.value);
    ls.page = 1;
    loadAndRenderList(key);
  });

  content.appendChild(h('div', { class: 'list-info-bar' }, [
    h('div', { class: 'result-count' }, [
      h('strong', null, [String(data.total)]),
      ` ${model.pluralLabel.toLowerCase()}${ls.search ? ' matching your search' : ''}`,
    ]),
    pageSize,
  ]));
  content.appendChild(h('div', { class: 'table-scroll' }, [table]));

  // Pagination
  const totalPages = data.totalPages || 1;
  const from = (ls.page - 1) * ls.pageSize + 1;
  const to = Math.min(ls.page * ls.pageSize, data.total);
  content.appendChild(
    h('div', { class: 'pagination' }, [
      h('span', null, [data.total === 0 ? 'No results' : `${from}\u2013${to} of ${data.total}`]),
      h('div', { class: 'controls' }, [
        h('button', { disabled: ls.page <= 1 ? 'true' : undefined, onclick: () => changePage(key, ls.page - 1) }, ['Previous']),
        h('span', { style: 'padding: 5px 4px;' }, [`Page ${ls.page} of ${totalPages}`]),
        h('button', { disabled: ls.page >= totalPages ? 'true' : undefined, onclick: () => changePage(key, ls.page + 1) }, ['Next']),
      ]),
    ]),
  );
}

function renderCellContent(field, value) {
  if (value === null || value === undefined || value === '') {
    return h('span', { class: 'field-value empty' }, ['\u2014']);
  }
  if (field.kind === 'boolean') {
    const span = h('span', null, [value ? 'Yes' : 'No']);
    span.className = value ? 'cell-bool-true' : 'cell-bool-false';
    return span;
  }
  if (field.kind === 'date') {
    return h('span', null, [formatDate(value)]);
  }
  if (field.kind === 'relation') {
    return h('span', { class: 'mono' }, [String(value)]);
  }
  if (field.kind === 'enum' || field.key === 'subscriptionStatus' || field.key === 'ownerRole') {
    const statusClass = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return h('span', { class: `cell-enum status-${statusClass}` }, [String(value).replace(/_/g, ' ')]);
  }
  const text = String(value);
  return h('span', null, [text.length > 60 ? text.slice(0, 60) + '\u2026' : text]);
}

function formatDate(value) {
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(value);
  }
}

function toggleSort(key, field) {
  const ls = listStateFor(key);
  if (ls.sortField === field) {
    ls.sortDir = ls.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    ls.sortField = field;
    ls.sortDir = 'desc';
  }
  ls.page = 1;
  loadAndRenderList(key);
}

function changePage(key, page) {
  const ls = listStateFor(key);
  ls.page = page;
  loadAndRenderList(key);
}

/* ------------------------------------------------------------------ */
/* Detail drawer                                                       */
/* ------------------------------------------------------------------ */

async function openDetail(modelKey, id, editing = false) {
  const model = modelDef(modelKey);
  try {
    const [detail, relations] = await Promise.all([
      api(`/models/${modelKey}/${id}`),
      api(`/models/${modelKey}/${id}/relations`).catch(() => ({ relations: {} })),
    ]);
    state.drawer = {
      modelKey,
      row: detail.row,
      relations: relations.relations || {},
      editing,
      draft: {},
    };
    renderDrawer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function closeDetail() {
  state.drawer = null;
  const existing = document.querySelector('.drawer-overlay');
  if (existing) existing.remove();
}

function defaultDraftFor(model) {
  const draft = {};
  for (const field of model.fields.filter((f) => f.creatable)) {
    if (field.kind === 'enum') draft[field.key] = field.enumValues[0];
    if (field.kind === 'boolean') draft[field.key] = false;
  }
  return draft;
}

function openCreate(modelKey) {
  const model = modelDef(modelKey);
  if (!model) return;
  state.drawer = {
    modelKey,
    row: {},
    relations: {},
    editing: true,
    creating: true,
    draft: defaultDraftFor(model),
  };
  renderDrawer();
}

function renderDrawer() {
  const existing = document.querySelector('.drawer-overlay');
  if (existing) existing.remove();
  if (!state.drawer) return;

  const { modelKey, row, relations, editing, creating } = state.drawer;
  const model = modelDef(modelKey);

  const overlay = h('div', {
    class: 'drawer-overlay',
    onclick: (e) => {
      if (e.target === overlay) closeDetail();
    },
  });

  const fields = creating ? model.fields.filter((f) => f.creatable) : model.fields.filter((f) => !f.createOnly);
  const fieldRows = fields.map((f) => buildFieldRow(f, row, relations, editing, creating));

  const drawer = h('div', { class: 'drawer' }, [
    h('div', { class: 'drawer-head' }, [
      h('div', null, [
        h('span', { class: 'drawer-eyebrow' }, [creating ? `New ${model.label}` : editing ? `Edit ${model.label}` : model.label]),
        h('h2', null, [creating ? `Add ${model.label}` : String(row[model.titleField] ?? model.label)]),
        h('div', { class: 'id mono' }, [creating ? 'Fill in the details below' : row.id]),
      ]),
      h('button', { class: 'drawer-close', onclick: closeDetail, 'aria-label': 'Close' }, ['\u00d7']),
    ]),
    h('div', { class: 'drawer-body' }, fieldRows),
    h('div', { class: 'drawer-foot' }, [
      creating ? h('span') : h('button', { class: 'btn btn-danger', onclick: () => confirmDelete(modelKey, row) }, ['Delete']),
      creating
        ? h('div', { style: 'display:flex; gap:8px;' }, [
            h('button', { class: 'btn btn-ghost', onclick: closeDetail }, ['Cancel']),
            h('button', { class: 'btn btn-primary', onclick: saveCreate }, [`Create ${model.label}`]),
          ])
        : editing
        ? h('div', { style: 'display:flex; gap:8px;' }, [
            h('button', { class: 'btn btn-ghost', onclick: cancelEdit }, ['Cancel']),
            h('button', { class: 'btn btn-primary', onclick: saveEdit }, ['Save changes']),
          ])
        : model.fields.some((f) => f.editable)
          ? h('button', { class: 'btn btn-primary', onclick: startEdit }, ['Edit'])
          : h('span', { class: 'sub', style: 'color: var(--ink-faint); font-size: 12px;' }, ['Read-only']),
    ]),
  ]);

  overlay.appendChild(drawer);
  document.body.appendChild(overlay);
}

function buildFieldRow(field, row, relations, editing, creating) {
  const value = row[field.key];
  const label = h('label', null, [
    field.label,
    creating && field.requiredForCreate ? h('span', { class: 'required-dot' }, [' *']) : null,
  ]);

  if (editing && (creating ? field.creatable : field.editable)) {
    return h('div', { class: 'field-row' }, [label, buildEditInput(field, value)]);
  }

  let displayNode;
  if (field.kind === 'relation') {
    const rel = relations[field.key];
    if (!rel) {
      displayNode = h('span', { class: 'field-value empty' }, ['\u2014']);
    } else {
      displayNode = h('a', { class: 'relation-link mono', href: '#', onclick: (e) => { e.preventDefault(); openDetail(field.relation.model, rel.id); } }, [rel.label]);
    }
  } else if (value === null || value === undefined || value === '') {
    displayNode = h('span', { class: 'field-value empty' }, ['\u2014']);
  } else if (field.kind === 'boolean') {
    displayNode = h('span', { class: 'field-value' }, [value ? 'Yes' : 'No']);
  } else if (field.kind === 'date') {
    displayNode = h('span', { class: 'field-value' }, [formatDate(value)]);
  } else if (field.key === 'id' || field.kind === 'json') {
    displayNode = h('span', { class: 'field-value mono' }, [String(value)]);
  } else {
    displayNode = h('span', { class: 'field-value' }, [String(value)]);
  }

  return h('div', { class: 'field-row' }, [label, displayNode]);
}

function buildEditInput(field, value) {
  const draft = state.drawer.draft;
  if (field.kind === 'boolean') {
    const checkbox = h('input', { type: 'checkbox' });
    checkbox.checked = draft.hasOwnProperty(field.key) ? draft[field.key] : Boolean(value);
    checkbox.addEventListener('change', () => {
      draft[field.key] = checkbox.checked;
    });
    return h('div', { class: 'checkbox-row' }, [checkbox, h('span', null, ['Enabled'])]);
  }
  if (field.kind === 'relation') {
    const input = h('input', {
      type: 'text',
      placeholder: `${field.relation.model} ID`,
      value: draft.hasOwnProperty(field.key) ? draft[field.key] : value ?? '',
    });
    input.addEventListener('input', () => {
      draft[field.key] = input.value;
    });
    if (state.drawer.creating && state.drawer.modelKey === 'user' && field.key === 'coupleId') {
      return h('div', { class: 'generated-input' }, [
        input,
        h('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onclick: async () => {
            try {
              const result = await api('/generate/couple', { method: 'POST' });
              draft.coupleId = result.couple.id;
              draft.isCoupleOwner = true;
              showToast(`Couple created. Invite code: ${result.couple.inviteCode}`, 'success');
              renderDrawer();
            } catch (err) {
              showToast(err.message, 'error');
            }
          },
        }, ['Generate']),
      ]);
    }
    return input;
  }
  if (field.kind === 'enum') {
    const select = h('select', null, field.enumValues.map((v) => h('option', { value: v }, [v])));
    select.value = draft.hasOwnProperty(field.key) ? draft[field.key] : value || field.enumValues[0];
    select.addEventListener('change', () => {
      draft[field.key] = select.value;
    });
    return select;
  }
  if (field.kind === 'date') {
    const input = h('input', { type: 'datetime-local' });
    const current = draft.hasOwnProperty(field.key) ? draft[field.key] : value;
    if (current) {
      const d = new Date(current);
      if (!Number.isNaN(d.getTime())) input.value = toLocalDatetimeValue(d);
    }
    input.addEventListener('change', () => {
      draft[field.key] = input.value ? new Date(input.value).toISOString() : null;
    });
    return input;
  }
  if (field.kind === 'number') {
    const input = h('input', { type: 'number', value: draft.hasOwnProperty(field.key) ? draft[field.key] : value ?? '' });
    input.addEventListener('input', () => {
      draft[field.key] = input.value === '' ? null : Number(input.value);
    });
    return input;
  }
  const isLong = (value && String(value).length > 60) || field.key === 'description' || field.key === 'body';
  const tag = isLong ? 'textarea' : 'input';
  const attrs = isLong ? {} : { type: field.key === 'password' ? 'password' : 'text' };
  const input = h(tag, attrs);
  input.value = draft.hasOwnProperty(field.key) ? draft[field.key] : value ?? '';
  input.addEventListener('input', () => {
    draft[field.key] = input.value;
  });
  if (state.drawer.creating && state.drawer.modelKey === 'couple' && field.key === 'inviteCode') {
    return h('div', { class: 'generated-input' }, [
      input,
      h('button', {
        class: 'btn btn-ghost',
        type: 'button',
        onclick: async () => {
          try {
            const result = await api('/generate/invite-code', { method: 'POST' });
            draft.inviteCode = result.inviteCode;
            input.value = result.inviteCode;
          } catch (err) {
            showToast(err.message, 'error');
          }
        },
      }, ['Generate']),
    ]);
  }
  return input;
}

function toLocalDatetimeValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startEdit() {
  state.drawer.editing = true;
  state.drawer.draft = {};
  renderDrawer();
}

function cancelEdit() {
  state.drawer.editing = false;
  state.drawer.draft = {};
  renderDrawer();
}

async function saveEdit() {
  const { modelKey, row, draft } = state.drawer;
  if (Object.keys(draft).length === 0) {
    state.drawer.editing = false;
    renderDrawer();
    return;
  }
  try {
    const result = await api(`/models/${modelKey}/${row.id}`, { method: 'PATCH', body: JSON.stringify(draft) });
    state.drawer.row = result.row;
    state.drawer.editing = false;
    state.drawer.draft = {};
    renderDrawer();
    showToast('Changes saved', 'success');
    if (state.view === modelKey) loadAndRenderList(modelKey);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveCreate() {
  const { modelKey, draft } = state.drawer;
  const model = modelDef(modelKey);
  const missingField = model.fields.find((field) => (
    field.requiredForCreate &&
    (draft[field.key] === undefined || draft[field.key] === null || String(draft[field.key]).trim() === '')
  ));
  if (missingField) {
    showToast(`${missingField.label} is required`, 'error');
    return;
  }
  try {
    const result = await api(`/models/${modelKey}`, { method: 'POST', body: JSON.stringify(draft) });
    state.drawer = {
      modelKey,
      row: result.row,
      relations: {},
      editing: false,
      creating: false,
      draft: {},
    };
    renderDrawer();
    showToast(`${model.label} created`, 'success');
    if (state.view === modelKey) loadAndRenderList(modelKey);
    loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Confirm modal (used for deletes)                                    */
/* ------------------------------------------------------------------ */

function confirmDelete(modelKey, row) {
  const model = modelDef(modelKey);
  const overlay = h('div', {
    class: 'confirm-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'delete-confirm-title',
    onclick: (event) => {
      if (event.target === overlay) overlay.remove();
    },
  }, [
    h('div', { class: 'confirm-box' }, [
      h('h3', { id: 'delete-confirm-title' }, [`Delete this ${model.label.toLowerCase()}?`]),
      h('p', null, [`This permanently removes "${String(row[model.titleField] ?? row.id).slice(0, 80)}". This can\u2019t be undone.`]),
      h('div', { class: 'row' }, [
        h('button', { class: 'btn btn-ghost', onclick: () => overlay.remove() }, ['Cancel']),
        h('button', {
          class: 'btn btn-danger',
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            button.textContent = 'Deleting\u2026';
            try {
              await api(`/models/${modelKey}/${row.id}`, { method: 'DELETE' });
              overlay.remove();
              closeDetail();
              showToast('Deleted', 'success');
              if (state.view === modelKey) loadAndRenderList(modelKey);
              loadDashboard();
            } catch (err) {
              button.disabled = false;
              button.textContent = 'Delete';
              showToast(err.message, 'error');
            }
          },
        }, ['Delete']),
      ]),
    ]),
  ]);
  document.body.appendChild(overlay);
}

/* ------------------------------------------------------------------ */
/* Root render dispatch                                                */
/* ------------------------------------------------------------------ */

function render() {
  const root = document.getElementById('app');
  if (state.authed === null) {
    clear(root);
    root.appendChild(h('div', { class: 'login-screen' }, [h('span', { class: 'spinner' })]));
    return;
  }
  if (state.authed === false) {
    clear(root);
    renderLogin(root);
    return;
  }
  renderShell(root);
}

boot();

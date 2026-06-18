'use strict';

const state = {
  apis: [],
  selected: new Set(), // ids
  forwards: new Map(), // id -> { localPort, localUrl }
  sort: { key: 'namespace', dir: 1 }, // dir: 1 asc, -1 desc
  filters: {}, // column key -> lowercase substring
  meshTimer: null,
  nsTimer: null,
};

const $ = (sel) => document.querySelector(sel);

// ---- helpers --------------------------------------------------------------

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 4000);
}

// ---- cluster --------------------------------------------------------------

async function loadCluster() {
  const pill = $('#cluster');
  const text = $('#cluster-text');
  try {
    const c = await api('GET', '/api/cluster');
    pill.className = 'cluster-pill ok';
    text.textContent = `${c.context}`;
    pill.title = `${c.server}`;
  } catch (err) {
    pill.className = 'cluster-pill bad';
    text.textContent = 'no cluster';
    pill.title = err.message;
  }
}

// ---- API discovery --------------------------------------------------------

async function loadApis() {
  const ns = $('#namespace').value.trim();
  const body = $('#api-body');
  body.innerHTML = '<tr><td colspan="8" class="empty">Loading…</td></tr>';
  try {
    const url = '/api/apis' + (ns ? `?namespace=${encodeURIComponent(ns)}` : '');
    const { apis } = await api('GET', url);
    state.apis = apis;
    // Drop selections that no longer exist.
    state.selected = new Set([...state.selected].filter((id) => apis.some((a) => a.id === id)));
    renderApis();
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="empty">⚠ ${escapeHtml(err.message)}</td></tr>`;
    state.apis = [];
    renderApis();
  }
}

// Field used for each filter/sort column.
function fieldValue(a, key) {
  if (key === 'servicePort') return String(a.servicePort);
  return String(a[key] ?? '');
}

// Apply the live column filters, then sort.
function getVisibleApis() {
  const filters = Object.entries(state.filters).filter(([, v]) => v);
  let list = state.apis.filter((a) =>
    filters.every(([key, val]) => fieldValue(a, key).toLowerCase().includes(val))
  );
  const { key, dir } = state.sort;
  list = list.slice().sort((a, b) => {
    if (key === 'servicePort') return (a.servicePort - b.servicePort) * dir;
    const cmp = fieldValue(a, key).localeCompare(fieldValue(b, key), undefined, { numeric: true });
    // stable secondary sort by namespace then name for ties
    return (cmp || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)) * dir;
  });
  return list;
}

function renderApis() {
  const body = $('#api-body');
  const visible = getVisibleApis();
  if (visible.length === 0) {
    const msg = state.apis.length === 0 ? 'No exposed APIs detected.' : 'No APIs match the filters.';
    body.innerHTML = `<tr><td colspan="8" class="empty">${msg}</td></tr>`;
  } else {
    body.innerHTML = visible
      .map((a) => {
        const checked = state.selected.has(a.id) ? 'checked' : '';
        return `<tr data-id="${escapeHtml(a.id)}">
          <td class="col-check"><input type="checkbox" class="row-check" ${checked} /></td>
          <td><strong>${escapeHtml(a.name)}</strong></td>
          <td>${escapeHtml(a.namespace)}</td>
          <td><span class="tag ${a.type}">${a.type}</span></td>
          <td>${a.servicePort}${a.portName ? ` <span class="summary">(${escapeHtml(a.portName)})</span>` : ''}</td>
          <td><input class="path-edit" value="${escapeHtml(a.path)}" /></td>
          <td><span class="tag ${a.source}">${a.source}</span></td>
          <td class="col-pf">${renderForwardCell(a.id)}</td>
        </tr>`;
      })
      .join('');
  }
  updateSortIndicators();
  updateSummary();
}

function updateSortIndicators() {
  document.querySelectorAll('.head-titles th.sortable').forEach((th) => {
    const arrow = th.querySelector('.arrow');
    if (!arrow) return;
    arrow.textContent = th.dataset.sort === state.sort.key ? (state.sort.dir === 1 ? '▲' : '▼') : '';
  });
}

function updateSummary() {
  const n = state.selected.size;
  const visible = getVisibleApis();
  const filtered = visible.length !== state.apis.length ? ` · ${visible.length} shown` : '';
  $('#summary').textContent = `${state.apis.length} API(s) detected${filtered} · ${n} selected`;
  $('#add-to-mesh').disabled = n === 0;
  $('#select-all').checked = visible.length > 0 && visible.every((a) => state.selected.has(a.id));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---- mesh -----------------------------------------------------------------

async function addToMesh() {
  const selected = state.apis
    .filter((a) => state.selected.has(a.id))
    .map((a) => {
      // apply any edited path from the row
      const row = document.querySelector(`tr[data-id="${CSS.escape(a.id)}"] .path-edit`);
      return { ...a, path: row ? row.value.trim() || a.path : a.path };
    });
  if (selected.length === 0) return;

  const btn = $('#add-to-mesh');
  btn.disabled = true;
  btn.textContent = 'Composing mesh…';
  try {
    const r = await api('POST', '/api/mesh', { selected });
    toast(`Mesh composed with ${selected.length} source(s).`, 'success');
    renderMesh(r.mesh);
  } catch (err) {
    toast(`Mesh error: ${err.message}`, 'error');
  } finally {
    btn.textContent = '＋ Add selected to Mesh';
    updateSummary();
  }
}

async function loadMesh() {
  try {
    const m = await api('GET', '/api/mesh');
    renderMesh(m);
  } catch (_) { /* ignore */ }
}

function renderMesh(m) {
  const pill = $('#mesh-status');
  pill.textContent = m.status;
  pill.className = `status-pill status-${m.status}`;

  $('#mesh-endpoint').textContent = m.endpoint || '—';
  $('#mesh-sources').textContent =
    m.sources && m.sources.length
      ? m.sources.map((s) => `${s.name} (${s.type})`).join(', ')
      : '—';

  const gql = $('#open-graphiql');
  gql.href = m.graphiql || '#';

  $('#download-schema').disabled = m.status !== 'running';
  $('#stop-mesh').disabled = m.status === 'stopped';

  if (m.logs && m.logs.length) {
    const pre = $('#mesh-logs');
    pre.textContent = m.logs.join('\n');
    pre.scrollTop = pre.scrollHeight;
  }
}

async function downloadSchema() {
  try {
    const res = await fetch('/api/mesh/schema');
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${res.status}`);
    }
    const sdl = await res.text();
    const blob = new Blob([sdl], { type: 'application/graphql' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mesh-schema.graphql';
    a.click();
    URL.revokeObjectURL(url);
    toast('Schema downloaded.', 'success');
  } catch (err) {
    toast(`Download failed: ${err.message}`, 'error');
  }
}

async function stopMesh() {
  try {
    const r = await api('DELETE', '/api/mesh');
    toast('Mesh stopped.', 'success');
    renderMesh(r.mesh);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- per-service port-forward --------------------------------------------

function renderForwardCell(id) {
  const f = state.forwards.get(id);
  if (f) {
    return `<button class="btn btn-pf-on pf-toggle" data-id="${escapeHtml(id)}">⛔ Disconnect</button>
      <a class="pf-link" href="${escapeHtml(f.localUrl)}" target="_blank" rel="noopener" title="${escapeHtml(f.localUrl)}">localhost:${f.localPort}</a>`;
  }
  return `<button class="btn pf-toggle" data-id="${escapeHtml(id)}">🔌 Connect</button>`;
}

function updateForwardCell(id) {
  const cell = document.querySelector(`tr[data-id="${CSS.escape(id)}"] .col-pf`);
  if (cell) cell.innerHTML = renderForwardCell(id);
}

async function toggleForward(id, btn) {
  const apiDesc = state.apis.find((a) => a.id === id);
  if (!apiDesc) return;
  const active = state.forwards.has(id);
  btn.disabled = true;
  btn.textContent = active ? 'Disconnecting…' : 'Connecting…';
  try {
    if (active) {
      await api('DELETE', '/api/portforward', { id });
      state.forwards.delete(id);
      toast(`Port-forward closed for ${apiDesc.name}.`, 'success');
    } else {
      // honour any edited path on the row
      const row = document.querySelector(`tr[data-id="${CSS.escape(id)}"] .path-edit`);
      const path = row ? row.value.trim() || apiDesc.path : apiDesc.path;
      const r = await api('POST', '/api/portforward', { api: { ...apiDesc, path } });
      state.forwards.set(id, r.forward);
      toast(`Forwarding ${apiDesc.name} → ${r.forward.localUrl}`, 'success');
    }
  } catch (err) {
    toast(`Port-forward failed: ${err.message}`, 'error');
  } finally {
    updateForwardCell(id);
    updateConnections();
  }
}

async function disconnectAll() {
  const count = state.forwards.size;
  if (count === 0) return;
  const btn = $('#disconnect-all');
  btn.disabled = true;
  try {
    await api('DELETE', '/api/portforward/all');
    const ids = [...state.forwards.keys()];
    state.forwards.clear();
    ids.forEach((id) => updateForwardCell(id));
    toast(`Closed ${count} connection(s).`, 'success');
  } catch (err) {
    toast(`Failed to disconnect all: ${err.message}`, 'error');
  } finally {
    updateConnections();
  }
}

// Live counter of open port-forwards + enable/disable "Disconnect all".
function updateConnections() {
  const n = state.forwards.size;
  $('#conn-count').textContent = String(n);
  $('#conn-pill').classList.toggle('active', n > 0);
  $('#disconnect-all').disabled = n === 0;
}

// Sync forward state from the server (survives page reloads / refreshes).
async function loadForwards() {
  try {
    const { forwards } = await api('GET', '/api/portforward');
    state.forwards = new Map(forwards.map((f) => [f.id, f]));
    state.apis.forEach((a) => updateForwardCell(a.id));
  } catch (_) {
    /* ignore */
  } finally {
    updateConnections();
  }
}

// ---- events ---------------------------------------------------------------

$('#refresh').addEventListener('click', loadApis);
$('#add-to-mesh').addEventListener('click', addToMesh);
$('#download-schema').addEventListener('click', downloadSchema);
$('#stop-mesh').addEventListener('click', stopMesh);
$('#disconnect-all').addEventListener('click', disconnectAll);

// Live namespace search (debounced server-side scope) — updates as you type.
$('#namespace').addEventListener('input', () => {
  clearTimeout(state.nsTimer);
  state.nsTimer = setTimeout(() => loadApis().then(loadForwards), 300);
});

// Live per-column filters (client-side) — updates as you type.
document.querySelectorAll('.head-filters input[data-filter]').forEach((input) => {
  input.addEventListener('input', () => {
    state.filters[input.dataset.filter] = input.value.trim().toLowerCase();
    renderApis();
  });
});

// Click a column header to sort (toggles asc/desc).
document.querySelectorAll('.head-titles th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: 1 };
    renderApis();
  });
});

$('#select-all').addEventListener('change', (e) => {
  const visible = getVisibleApis();
  if (e.target.checked) visible.forEach((a) => state.selected.add(a.id));
  else visible.forEach((a) => state.selected.delete(a.id));
  renderApis();
});

$('#api-body').addEventListener('change', (e) => {
  if (!e.target.classList.contains('row-check')) return;
  const id = e.target.closest('tr').dataset.id;
  if (e.target.checked) state.selected.add(id);
  else state.selected.delete(id);
  updateSummary();
});

// Persist edited endpoint paths so they survive re-renders (sort/filter/refresh).
$('#api-body').addEventListener('input', (e) => {
  if (!e.target.classList.contains('path-edit')) return;
  const id = e.target.closest('tr').dataset.id;
  const apiDesc = state.apis.find((a) => a.id === id);
  if (apiDesc) apiDesc.path = e.target.value;
});

$('#api-body').addEventListener('click', (e) => {
  const btn = e.target.closest('.pf-toggle');
  if (!btn) return;
  toggleForward(btn.dataset.id, btn);
});

// ---- init -----------------------------------------------------------------

loadCluster();
loadApis().then(loadForwards);
loadMesh();
// Poll mesh status so logs/state stay live.
setInterval(loadMesh, 3000);

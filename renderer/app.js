const state = {
  data: { fronts: [], summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } },
  open: false,
  selectedPane: null,
  inlineEditSession: null,
  shortcutMode: false,
  frontOrder: [],
  openFronts: new Set()
};

const $ = (id) => document.getElementById(id);
const pill     = $('pill');
const panel    = $('panel');
const frontsEl = $('fronts');

// ── Mouse passthrough ─────────────────────────────────────────────────────
// sendSync ensures cursor switches in same frame (no async lag).
// State tracking avoids spamming IPC on every mousemove.
let _ignoring = true;
function setIgnoreIfChanged(ignore) {
  if (ignore === _ignoring) return;
  _ignoring = ignore;
  window.helm.setIgnoreMouse(ignore);
}
document.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const overUI = !!el && el !== document.documentElement && el !== document.body;
  setIgnoreIfChanged(!overUI);
});
document.addEventListener('mouseleave', () => setIgnoreIfChanged(true));

// ── Events ────────────────────────────────────────────────────────────────

pill.addEventListener('click', () => togglePanel());
pill.addEventListener('keydown', (e) => { if (e.key === 'Enter') togglePanel(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state.shortcutMode && state.selectedPane) navigateTo(state.selectedPane);
  if (e.key === 'Escape' && state.open) togglePanel(false);
});

window.helm.onShortcutFired(() => {
  state.shortcutMode = true;
  if (!state.open) togglePanel(true);
  const oldest = state.data?.summary?.oldestWaiting;
  if (!oldest) return;
  for (const f of state.data.fronts) {
    const ag = f.agents.find(a => a.paneId === oldest.paneId);
    if (ag) { state.selectedPane = { ...ag, sessionName: f.sessionName, weztermTabId: f.weztermTabId }; break; }
  }
  render();
});

window.helm.onStateUpdate((next) => {
  if (!next) return;
  applyFrontOrder(next);
  state.data = next;
  if (!state.inlineEditSession) render();
});

// Load initial state + persisted front order
window.helm.getState().then((initial) => {
  if (initial) { applyFrontOrder(initial); state.data = initial; }
  render();
}).catch(() => render());

// Load front order from disk on startup
window.helm.getFrontOrder().then((order) => {
  if (Array.isArray(order) && order.length) state.frontOrder = order;
}).catch(() => {});

// ── Helpers ───────────────────────────────────────────────────────────────

function applyFrontOrder(data) {
  if (state.frontOrder.length > 0 && data.fronts) {
    data.fronts = [...data.fronts].sort((a, b) => {
      const ai = state.frontOrder.indexOf(a.sessionName);
      const bi = state.frontOrder.indexOf(b.sessionName);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }
}

function togglePanel(force) {
  state.open = typeof force === 'boolean' ? force : !state.open;
  panel.hidden = !state.open;
  render();
  resizeToContent();
}

function resizeToContent() {
  if (!state.open) { window.helm.resizeWindow(52); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const h = Math.min(560, (panel.scrollHeight || 200) + 60);
    window.helm.resizeWindow(h);
  }));
}

function navigateTo(agent) {
  window.helm.navigateToPane(agent.sessionName, agent.windowName, agent.paneId, agent.weztermTabId);
  state.shortcutMode = false;
  $('shortcut-hint').hidden = true;
}

function agentTag(command) {
  return String(command || '').toLowerCase().includes('codex') ? 'codex' : 'claude';
}

function cls(el, name, on) { on ? el.classList.add(name) : el.classList.remove(name); }
function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

function escapeHtml(text) {
  return String(text || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// ── Main render ───────────────────────────────────────────────────────────

function render() {
  const waiting = state.data.summary?.waiting || 0;

  setText($('pill-text'), waiting > 0 ? `${waiting} aguardando` : 'tudo rodando');
  pill.className = waiting > 0 ? 'pill' : 'pill all-ok';

  // Pill dots
  const dots = [];
  const runCount = Math.min(4, state.data.summary?.totalAgents || 0);
  const waitCount = Math.min(2, waiting);
  for (let i = 0; i < waitCount; i++) dots.push('<div class="pdot wait"></div>');
  for (let i = 0; i < Math.max(1, runCount - waitCount); i++) dots.push('<div class="pdot run"></div>');
  $('pill-dots').innerHTML = dots.join('');

  setText($('sum-fronts'), String(state.data.summary?.total || 0));
  setText($('sum-agents'), String(state.data.summary?.totalAgents || 0));
  setText($('sum-waiting'), String(waiting));
  $('shortcut-hint').hidden = !state.shortcutMode;

  reconcileFronts();
}

// ── Fronts reconciler ─────────────────────────────────────────────────────

function reconcileFronts() {
  const fronts = state.data.fronts || [];

  // Index existing elements
  const bySession = new Map();
  for (const el of Array.from(frontsEl.children)) {
    if (el.dataset.session) bySession.set(el.dataset.session, el);
  }

  // Remove stale
  for (const [name, el] of bySession) {
    if (!fronts.find(f => f.sessionName === name)) { el.remove(); bySession.delete(name); }
  }

  // Update or create in order
  fronts.forEach((front, idx) => {
    let el = bySession.get(front.sessionName);
    if (!el) {
      el = createFrontEl(front);
      bySession.set(front.sessionName, el);
    } else {
      patchFrontEl(el, front);
    }
    if (frontsEl.children[idx] !== el) frontsEl.insertBefore(el, frontsEl.children[idx] || null);
  });
}

function createFrontEl(front) {
  const el = document.createElement('div');
  el.dataset.session = front.sessionName;
  if (state.openFronts.has(front.sessionName)) el.classList.add('open');

  const wait = front.agents.filter(a => a.status === 'waiting').length;
  const run  = front.agents.filter(a => a.status === 'running').length;

  el.className = frontClasses(wait) + (state.openFronts.has(front.sessionName) ? ' open' : '');
  el.setAttribute('draggable', 'true');

  el.innerHTML = `
    <div class="front-head">
      <div class="fh-row">
        <span class="drag-handle" draggable="false">⠿</span>
        <span class="fname">${escapeHtml(front.name || front.sessionName)}</span>
        ${front.aiSuggested ? '<button class="name-btn ok" data-action="confirm">✓ ok</button>' : ''}
        <button class="name-btn" data-action="edit">editar</button>
      </div>
      <div class="fagents-summary">
        ${wait ? '<div class="fas-dot wait"></div>' : ''}
        ${run  ? '<div class="fas-dot run"></div>' : ''}
        <span class="fas-count ${wait ? 'alert' : ''}">${wait} aguardando · ${run} rodando</span>
      </div>
    </div>
    <div class="fdiv"></div>
    <div class="agents"></div>
  `;

  attachFrontEvents(el, front);
  reconcileAgentRows(el.querySelector('.agents'), front);
  return el;
}

function patchFrontEl(el, front) {
  const wait = front.agents.filter(a => a.status === 'waiting').length;
  const run  = front.agents.filter(a => a.status === 'running').length;
  const isOpen = el.classList.contains('open');
  const isSelected = state.selectedPane && front.agents.some(a => a.paneId === state.selectedPane?.paneId);

  el.className = frontClasses(wait) + (isOpen ? ' open' : '') + (isSelected ? ' shortcut-selected' : '');

  // Summary
  const fasCount = el.querySelector('.fas-count');
  if (fasCount) {
    setText(fasCount, `${wait} aguardando · ${run} rodando`);
    cls(fasCount, 'alert', wait > 0);
  }

  // Update summary dots
  const summary = el.querySelector('.fagents-summary');
  if (summary) {
    const dots = summary.querySelectorAll('.fas-dot');
    // Simple approach: rebuild dots only if count changed
    const hasWaitDot = Array.from(dots).some(d => d.classList.contains('wait'));
    const hasRunDot  = Array.from(dots).some(d => d.classList.contains('run'));
    if ((wait > 0) !== hasWaitDot || (run > 0) !== hasRunDot) {
      // Remove old dots
      dots.forEach(d => d.remove());
      // Insert before fas-count
      if (wait > 0) { const d = document.createElement('div'); d.className = 'fas-dot wait'; summary.insertBefore(d, fasCount); }
      if (run > 0)  { const d = document.createElement('div'); d.className = 'fas-dot run';  summary.insertBefore(d, fasCount); }
    }
  }

  // Name (skip during inline edit)
  if (state.inlineEditSession !== front.sessionName) {
    const hasInput = !!el.querySelector('.fname-input');
    if (hasInput) {
      rebuildNameRow(el, front);
    } else {
      setText(el.querySelector('.fname'), front.name || front.sessionName);
      const hasConfirm = !!el.querySelector('[data-action="confirm"]');
      if (front.aiSuggested !== hasConfirm) rebuildNameRow(el, front);
    }
  }

  reconcileAgentRows(el.querySelector('.agents'), front);
}

function frontClasses(waitCount) {
  return `front ${waitCount > 0 ? 'has-wait' : 'all-run'}`;
}

// ── Front events (attached once) ──────────────────────────────────────────

function attachFrontEvents(el, front) {
  // Drag
  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.front.drag-over').forEach(f => f.classList.remove('drag-over'));
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    const src = document.querySelector('.front.dragging');
    if (src && src !== el) el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const src = document.querySelector('.front.dragging');
    if (!src || src === el) return;
    const fronts = state.data.fronts;
    const from = fronts.findIndex(f => f.sessionName === src.dataset.session);
    const to   = fronts.findIndex(f => f.sessionName === el.dataset.session);
    if (from !== -1 && to !== -1) {
      const [moved] = fronts.splice(from, 1);
      fronts.splice(to, 0, moved);
      state.frontOrder = fronts.map(f => f.sessionName);
      window.helm.saveFrontOrder(state.frontOrder);
      reconcileFronts();
    }
  });

  // Toggle open on header click
  el.querySelector('.front-head').addEventListener('click', (e) => {
    if (e.target.closest('.name-btn') || e.target.closest('.fname-input')) return;
    el.classList.toggle('open');
    const session = el.dataset.session;
    el.classList.contains('open') ? state.openFronts.add(session) : state.openFronts.delete(session);
    resizeToContent();
  });

  // Name button delegation (works for dynamically replaced buttons)
  el.querySelector('.fh-row').addEventListener('click', (e) => {
    const btn = e.target.closest('.name-btn');
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.action;
    const session = el.dataset.session;
    const frontData = state.data.fronts.find(f => f.sessionName === session);
    if (!frontData) return;

    if (action === 'edit') {
      state.inlineEditSession = session;
      rebuildNameRow(el, frontData);
    } else if (action === 'confirm') {
      window.helm.confirmName(session, frontData.name || session);
    } else if (action === 'save') {
      const input = el.querySelector('.fname-input');
      const name = input ? input.value.trim() || session : session;
      if (frontData) { frontData.name = name; frontData.aiSuggested = false; }
      window.helm.confirmName(session, name);
      state.inlineEditSession = null;
      render();
    }
  });
}

function rebuildNameRow(el, front) {
  const fhRow = el.querySelector('.fh-row');
  if (!fhRow) return;
  const displayName = front.name || front.sessionName;

  if (state.inlineEditSession === front.sessionName) {
    fhRow.innerHTML = `
      <span class="drag-handle" draggable="false">⠿</span>
      <div class="fname-edit">
        <input class="fname-input" value="${escapeHtml(displayName)}" data-session="${escapeHtml(front.sessionName)}" />
        <button class="name-btn ok" data-action="save">✓ ok</button>
      </div>
    `;
    const input = fhRow.querySelector('.fname-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); state.inlineEditSession = null; render(); }
        if (e.key === 'Enter')  { e.stopPropagation(); fhRow.querySelector('[data-action="save"]')?.click(); }
      });
      setTimeout(() => input.focus(), 0);
    }
  } else {
    fhRow.innerHTML = `
      <span class="drag-handle" draggable="false">⠿</span>
      <span class="fname">${escapeHtml(displayName)}</span>
      ${front.aiSuggested ? '<button class="name-btn ok" data-action="confirm">✓ ok</button>' : ''}
      <button class="name-btn" data-action="edit">editar</button>
    `;
  }
}

// ── Agent rows reconciler ─────────────────────────────────────────────────

function reconcileAgentRows(agentsEl, front) {
  if (!agentsEl) return;

  const byPane = new Map();
  for (const row of agentsEl.querySelectorAll('.agent-row[data-pane]')) byPane.set(row.dataset.pane, row);

  // Remove stale
  for (const [id, row] of byPane) {
    if (!front.agents.find(a => a.paneId === id)) { row.remove(); byPane.delete(id); }
  }

  front.agents.forEach((agent, idx) => {
    let row = byPane.get(agent.paneId);
    if (!row) {
      row = createAgentRow(agent, front);
      byPane.set(agent.paneId, row);
    } else {
      patchAgentRow(row, agent);
    }
    if (agentsEl.children[idx] !== row) agentsEl.insertBefore(row, agentsEl.children[idx] || null);
  });
}

function createAgentRow(agent, front) {
  const row = document.createElement('div');
  row.className = `agent-row ${agent.status === 'waiting' ? 'is-wait' : ''}`;
  row.dataset.pane = agent.paneId;
  const tag = agentTag(agent.command);
  row.innerHTML = `
    <div class="ar-dot ${agent.status === 'waiting' ? 'wait' : 'run'}"></div>
    <div class="ar-body">
      <div class="ar-top">
        <span class="ar-agent ${tag}">${escapeHtml(tag)}</span>
        <span class="ar-task">${escapeHtml(agent.task || agent.windowName)}</span>
      </div>
      <div class="ar-preview ${agent.status === 'waiting' ? 'wait-prev' : ''}">${escapeHtml(agent.lastOutput || '')}</div>
    </div>
    <div class="ar-nav">ir →</div>
  `;
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateTo({ ...agent, sessionName: front.sessionName, weztermTabId: front.weztermTabId });
  });
  return row;
}

function patchAgentRow(row, agent) {
  const isWait = agent.status === 'waiting';
  cls(row, 'is-wait', isWait);

  const dot = row.querySelector('.ar-dot');
  if (dot) dot.className = `ar-dot ${isWait ? 'wait' : 'run'}`;

  const task = row.querySelector('.ar-task');
  if (task) setText(task, agent.task || agent.windowName);

  const preview = row.querySelector('.ar-preview');
  if (preview) {
    cls(preview, 'wait-prev', isWait);
    setText(preview, agent.lastOutput || '');
  }
}

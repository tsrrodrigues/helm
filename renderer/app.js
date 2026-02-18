const state = {
  data: { fronts: [], summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } },
  open: false,
  selectedPane: null,
  inlineEditSession: null,
  shortcutMode: false,
  frontOrder: [],
  openFronts: new Set(),
  dismissedPanes: new Set()
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

window.helm.onActiveApp(({ isTerminal }) => {
  if (!isTerminal && state.open) togglePanel(false);
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

  // Build set of previously waiting panes
  const prevWaiting = new Set();
  for (const f of (state.data.fronts || [])) {
    for (const a of f.agents) { if (a.status === 'waiting') prevWaiting.add(a.paneId); }
  }

  // Build set of currently waiting panes
  const nowWaiting = new Set();
  for (const f of (next.fronts || [])) {
    for (const a of f.agents) { if (a.status === 'waiting') nowWaiting.add(a.paneId); }
  }

  // Clear dismiss for panes that left waiting (so next time they wait it's a fresh alert)
  for (const paneId of state.dismissedPanes) {
    if (!nowWaiting.has(paneId)) state.dismissedPanes.delete(paneId);
  }

  // Auto-open panel when an agent transitions to "waiting" (ignore dismissed)
  let newWaiting = false;
  for (const paneId of nowWaiting) {
    if (!prevWaiting.has(paneId) && !state.dismissedPanes.has(paneId)) newWaiting = true;
  }
  if (newWaiting) {
    for (const f of (next.fronts || [])) state.openFronts.add(f.sessionName);
    if (!state.open) togglePanel(true);
  }

  state.data = next;
  if (!state.inlineEditSession) render();
});

// Load initial state + persisted front order
window.helm.getState().then((initial) => {
  if (initial) { applyFrontOrder(initial); state.data = initial; }
  render();
}).catch(() => render());

// Load front order from disk on startup — re-render if data already arrived
window.helm.getFrontOrder().then((order) => {
  if (Array.isArray(order) && order.length) {
    state.frontOrder = order;
    if (state.data.fronts.length) { applyFrontOrder(state.data); render(); }
  }
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
  state.dismissedPanes.add(agent.paneId);
  window.helm.navigateToPane(agent.sessionName, agent.windowName, agent.paneId, agent.weztermTabId);
  state.shortcutMode = false;
  $('shortcut-hint').hidden = true;
  render();
}

function agentTag(command) {
  const c = String(command || '').toLowerCase();
  if (c.includes('codex')) return 'codex';
  // Claude Code reports version as command (e.g. "2.1.37"), treat as claude
  return 'claude';
}

function formatElapsed(startedAtMs) {
  if (!startedAtMs) return '';
  const sec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (sec < 60) return '< 1m';
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function cls(el, name, on) { on ? el.classList.add(name) : el.classList.remove(name); }
function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

function escapeHtml(text) {
  return String(text || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// ── Main render ───────────────────────────────────────────────────────────

function render() {
  // Effective waiting = waiting agents NOT dismissed
  let effectiveWaiting = 0;
  for (const f of (state.data.fronts || [])) {
    for (const a of f.agents) {
      if (a.status === 'waiting' && !state.dismissedPanes.has(a.paneId)) effectiveWaiting++;
    }
  }

  setText($('pill-text'), effectiveWaiting > 0 ? `${effectiveWaiting} aguardando` : 'tudo rodando');
  pill.className = effectiveWaiting > 0 ? 'pill' : 'pill all-ok';

  // Pill dots
  const dots = [];
  const runCount = Math.min(4, state.data.summary?.totalAgents || 0);
  const waitCount = Math.min(2, effectiveWaiting);
  for (let i = 0; i < waitCount; i++) dots.push('<div class="pdot wait"></div>');
  for (let i = 0; i < Math.max(1, runCount - waitCount); i++) dots.push('<div class="pdot run"></div>');
  $('pill-dots').innerHTML = dots.join('');

  setText($('sum-fronts'), String(state.data.summary?.total || 0));
  setText($('sum-agents'), String(state.data.summary?.totalAgents || 0));
  setText($('sum-waiting'), String(effectiveWaiting));
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

  const effectiveWait = front.agents.filter(a => a.status === 'waiting' && !state.dismissedPanes.has(a.paneId)).length;
  const run  = front.agents.filter(a => a.status === 'running').length;

  el.className = frontClasses(effectiveWait) + (state.openFronts.has(front.sessionName) ? ' open' : '');

  el.innerHTML = `
    <div class="front-head">
      <div class="fh-row">
        <span class="drag-handle" draggable="false">⠿</span>
        <span class="fname">${escapeHtml(front.name || front.sessionName)}</span>
        ${front.aiSuggested ? '<button class="name-btn ok" data-action="confirm">✓ ok</button>' : ''}
        <button class="name-btn" data-action="edit">editar</button>
      </div>
      <div class="fagents-summary">
        ${effectiveWait ? '<div class="fas-dot wait"></div>' : ''}
        ${run  ? '<div class="fas-dot run"></div>' : ''}
        <span class="fas-count ${effectiveWait ? 'alert' : ''}">${effectiveWait} aguardando · ${run} rodando</span>
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
  const effectiveWait = front.agents.filter(a => a.status === 'waiting' && !state.dismissedPanes.has(a.paneId)).length;
  const run  = front.agents.filter(a => a.status === 'running').length;
  const isOpen = state.openFronts.has(front.sessionName);
  const isSelected = state.selectedPane && front.agents.some(a => a.paneId === state.selectedPane?.paneId);

  el.className = frontClasses(effectiveWait) + (isOpen ? ' open' : '') + (isSelected ? ' shortcut-selected' : '');

  // Summary
  const fasCount = el.querySelector('.fas-count');
  if (fasCount) {
    setText(fasCount, `${effectiveWait} aguardando · ${run} rodando`);
    cls(fasCount, 'alert', effectiveWait > 0);
  }

  // Update summary dots
  const summary = el.querySelector('.fagents-summary');
  if (summary) {
    const dots = summary.querySelectorAll('.fas-dot');
    // Simple approach: rebuild dots only if count changed
    const hasWaitDot = Array.from(dots).some(d => d.classList.contains('wait'));
    const hasRunDot  = Array.from(dots).some(d => d.classList.contains('run'));
    if ((effectiveWait > 0) !== hasWaitDot || (run > 0) !== hasRunDot) {
      // Remove old dots
      dots.forEach(d => d.remove());
      // Insert before fas-count
      if (effectiveWait > 0) { const d = document.createElement('div'); d.className = 'fas-dot wait'; summary.insertBefore(d, fasCount); }
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

function frontClasses(effectiveWaitCount) {
  return `front ${effectiveWaitCount > 0 ? 'has-wait' : 'all-run'}`;
}

// ── Front events (attached once) ──────────────────────────────────────────

function attachFrontEvents(el, front) {
  // Manual drag-to-reorder via handle (HTML5 D&D doesn't work on transparent Electron windows)
  const handle = el.querySelector('.drag-handle');
  if (handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startDrag(el, e.clientX);
    });
  }

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

// ── Manual drag-to-reorder ─────────────────────────────────────────────────

let _dragging = null;

function startDrag(el, startX) {
  setIgnoreIfChanged(false);  // ensure mouse events work during drag
  el.classList.add('dragging');
  _dragging = { el, startX, startLeft: el.offsetLeft };

  const siblings = Array.from(frontsEl.children).filter(c => c !== el && c.dataset.session);
  // Store midpoints of siblings for hit testing
  const targets = siblings.map(s => ({
    el: s,
    mid: s.offsetLeft + s.offsetWidth / 2,
    session: s.dataset.session
  }));

  function onMove(e) {
    const dx = e.clientX - startX;
    el.style.transform = `translateX(${dx}px)`;
    el.style.zIndex = '100';

    // Highlight drop target
    const elMid = _dragging.startLeft + el.offsetWidth / 2 + dx;
    siblings.forEach(s => s.classList.remove('drag-over'));
    // Find which sibling we're overlapping
    let closest = null, closestDist = Infinity;
    for (const t of targets) {
      const dist = Math.abs(elMid - t.mid);
      if (dist < closestDist && dist < el.offsetWidth * 0.6) {
        closestDist = dist;
        closest = t;
      }
    }
    if (closest) closest.el.classList.add('drag-over');
  }

  function onUp(e) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    el.style.transform = '';
    el.style.zIndex = '';
    el.classList.remove('dragging');
    siblings.forEach(s => s.classList.remove('drag-over'));

    // Find drop target
    const dx = e.clientX - startX;
    const elMid = _dragging.startLeft + el.offsetWidth / 2 + dx;
    let closest = null, closestDist = Infinity;
    for (const t of targets) {
      const dist = Math.abs(elMid - t.mid);
      if (dist < closestDist && dist < el.offsetWidth * 0.6) {
        closestDist = dist;
        closest = t;
      }
    }

    if (closest) {
      const fronts = state.data.fronts;
      const from = fronts.findIndex(f => f.sessionName === el.dataset.session);
      const to   = fronts.findIndex(f => f.sessionName === closest.session);
      if (from !== -1 && to !== -1 && from !== to) {
        const [moved] = fronts.splice(from, 1);
        fronts.splice(to, 0, moved);
        state.frontOrder = fronts.map(f => f.sessionName);
        window.helm.saveFrontOrder(state.frontOrder);
        reconcileFronts();
      }
    }

    _dragging = null;
    setTimeout(() => setIgnoreIfChanged(true), 50);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
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
      patchAgentRow(row, agent, front);
    }
    if (agentsEl.children[idx] !== row) agentsEl.insertBefore(row, agentsEl.children[idx] || null);
  });
}

function createAgentRow(agent, front) {
  const row = document.createElement('div');
  const isWait = agent.status === 'waiting';
  const isDismissed = isWait && state.dismissedPanes.has(agent.paneId);
  row.className = `agent-row${isWait ? ' is-wait' : ''}${isDismissed ? ' is-dismissed' : ''}`;
  row.dataset.pane = agent.paneId;
  const tag = agentTag(agent.command);
  row.innerHTML = `
    <div class="ar-dot ${isWait ? 'wait' : 'run'}"></div>
    <div class="ar-body">
      <div class="ar-top">
        <span class="ar-agent ${tag}">${escapeHtml(tag)}</span>
        <span class="ar-time">${formatElapsed(agent.interactionStartedAt)}</span>
      </div>
      <div class="ar-name">${escapeHtml(agent.task || agent.windowName)}</div>
    </div>
    <div class="ar-dismiss" data-pane="${agent.paneId}" title="marcar como visto">✓</div>
    <div class="ar-nav">ir →</div>
  `;
  row.querySelector('.ar-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    state.dismissedPanes.add(agent.paneId);
    render();
  });
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateTo({ ...agent, sessionName: front.sessionName, weztermTabId: front.weztermTabId });
  });
  return row;
}

function patchAgentRow(row, agent, front) {
  const isWait = agent.status === 'waiting';
  const isDismissed = isWait && state.dismissedPanes.has(agent.paneId);
  cls(row, 'is-wait', isWait);
  cls(row, 'is-dismissed', isDismissed);

  const dot = row.querySelector('.ar-dot');
  if (dot) dot.className = `ar-dot ${isWait ? 'wait' : 'run'}`;

  const nameEl = row.querySelector('.ar-name');
  if (nameEl) setText(nameEl, agent.task || agent.windowName);

  const time = row.querySelector('.ar-time');
  if (time) setText(time, formatElapsed(agent.interactionStartedAt));
}

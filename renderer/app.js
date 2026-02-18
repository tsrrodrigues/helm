const state = {
  data: { fronts: [], summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } },
  open: false,
  selectedPane: null,
  inlineEditSession: null,
  shortcutMode: false,
  frontOrder: [],    // persists user-defined order
  openFronts: new Set()  // per-front open state (survives re-renders)
};

const $ = (id) => document.getElementById(id);
const pill  = $('pill');
const panel = $('panel');
const frontsEl = $('fronts');

pill.addEventListener('click', () => togglePanel());
pill.addEventListener('keydown', (e) => { if (e.key === 'Enter') togglePanel(); });

// Hover tracking: toggle ignoreMouseEvents based on cursor position.
// Only send IPC when state actually changes (avoids spamming main process on every mousemove).
// sendSync ensures the cursor switches in the same frame with no async lag.
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state.shortcutMode && state.selectedPane) {
    navigateTo(state.selectedPane);
  }
});

window.helm.onShortcutFired(() => {
  state.shortcutMode = true;
  if (!state.open) togglePanel(true);
  const oldest = state.data?.summary?.oldestWaiting;
  if (!oldest) return;

  for (const f of state.data.fronts) {
    const ag = f.agents.find((a) => a.paneId === oldest.paneId);
    if (ag) {
      state.selectedPane = { ...ag, sessionName: f.sessionName, weztermTabId: f.weztermTabId };
      break;
    }
  }
  render();
});

window.helm.onStateUpdate((next) => {
  if (!next) return;

  // Apply user-defined order before rendering
  if (state.frontOrder.length > 0 && next.fronts) {
    next.fronts = [...next.fronts].sort((a, b) => {
      const ai = state.frontOrder.indexOf(a.sessionName);
      const bi = state.frontOrder.indexOf(b.sessionName);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  state.data = next;

  // Don't re-render while user is editing a name — it would reset the input
  if (state.inlineEditSession) return;

  render();
});

window.helm.getState().then((initial) => {
  if (initial) state.data = initial;
  render();
}).catch(() => render());

// ── Helpers ──────────────────────────────────────────────────────────────

function togglePanel(force) {
  state.open = typeof force === 'boolean' ? force : !state.open;
  panel.hidden = !state.open;
  render();
  resizeToContent();
}

function resizeToContent() {
  if (!state.open) {
    window.helm.resizeWindow(52);
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const h = Math.min(560, (panel.scrollHeight || 200) + 60);
      window.helm.resizeWindow(h);
    });
  });
}

function navigateTo(agent) {
  window.helm.navigateToPane(agent.sessionName, agent.windowName, agent.paneId, agent.weztermTabId);
  state.shortcutMode = false;
  $('shortcut-hint').hidden = true;
}

function agentTag(command) {
  const c = String(command || '').toLowerCase();
  if (c.includes('codex')) return 'codex';
  return 'claude';
}

function cls(el, name, on) {
  on ? el.classList.add(name) : el.classList.remove(name);
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ── Main render ───────────────────────────────────────────────────────────
// Reconciliation approach: never wipe the DOM, only patch what changed.
// This eliminates flicker from complete re-renders on every daemon poll.

function render() {
  const waiting = state.data.summary?.waiting || 0;

  // Pill label + class
  setText($('pill-text'), waiting > 0 ? `${waiting} aguardando` : 'tudo rodando');
  pill.className = waiting > 0 ? 'pill' : 'pill all-ok';

  // Pill dots (small, OK to rebuild)
  const dots = [];
  const runCount = Math.min(4, state.data.summary?.totalAgents || 0);
  const waitCount = Math.min(2, waiting);
  for (let i = 0; i < waitCount; i++) dots.push('<div class="pdot wait"></div>');
  for (let i = 0; i < Math.max(1, runCount - waitCount); i++) dots.push('<div class="pdot run"></div>');
  $('pill-dots').innerHTML = dots.join('');

  setText($('sum-fronts'), state.data.summary?.total || 0);
  setText($('sum-agents'), state.data.summary?.totalAgents || 0);
  setText($('sum-waiting'), waiting);

  $('shortcut-hint').hidden = !state.shortcutMode;

  patchFronts();
}

// ── Fronts reconciler ─────────────────────────────────────────────────────

function patchFronts() {
  const fronts = state.data.fronts || [];

  // Index existing elements by session name
  const bySession = new Map();
  for (const el of Array.from(frontsEl.children)) {
    if (el.dataset.session) bySession.set(el.dataset.session, el);
  }

  // Remove fronts that disappeared from state
  for (const [name, el] of bySession) {
    if (!fronts.find(f => f.sessionName === name)) {
      el.remove();
      bySession.delete(name);
    }
  }

  // Update or create each front in correct order
  fronts.forEach((front, idx) => {
    let el = bySession.get(front.sessionName);
    if (!el) {
      el = buildFrontEl(front);
      bySession.set(front.sessionName, el);
    } else {
      patchFrontEl(el, front);
    }
    // Reorder DOM node if needed (cheap if already in place)
    const atIdx = frontsEl.children[idx];
    if (atIdx !== el) frontsEl.insertBefore(el, atIdx || null);
  });
}

function buildFrontEl(front) {
  const el = document.createElement('div');
  el.dataset.session = front.sessionName;

  // Restore open state from persistent set
  if (state.openFronts.has(front.sessionName)) el.classList.add('open');

  // Front header HTML (rebuilt only when element is new)
  const waitInFront = front.agents.filter(a => a.status === 'waiting').length;
  const runInFront  = front.agents.filter(a => a.status === 'running').length;
  el.className = buildFrontClass(front, waitInFront);

  el.innerHTML = `
    <div class="front-head">
      <div class="fh-row">
        <span class="drag-handle" draggable="false">⠿</span>
        <span class="fname">${escapeHtml(front.name || front.sessionName)}</span>
        ${front.aiSuggested ? '<button class="name-btn ok" data-action="confirm">✓ ok</button>' : ''}
        <button class="name-btn" data-action="edit">editar</button>
      </div>
      <div class="fagents-summary">
        <div class="fas-dot ${waitInFront ? 'wait' : 'run'}" style="${waitInFront ? '' : 'display:none'}"></div>
        <div class="fas-dot run" style="${runInFront ? '' : 'display:none'}"></div>
        <span class="fas-count ${waitInFront ? 'alert' : ''}">${waitInFront} aguardando · ${runInFront} rodando</span>
      </div>
    </div>
    <div class="fdiv"></div>
    <div class="agents"></div>
  `;

  attachFrontEvents(el, front);
  patchAgentRows(el.querySelector('.agents'), front);
  return el;
}

function patchFrontEl(el, front) {
  const waitInFront = front.agents.filter(a => a.status === 'waiting').length;
  const runInFront  = front.agents.filter(a => a.status === 'running').length;
  const isSelected  = state.selectedPane && front.agents.some(a => a.paneId === state.selectedPane.paneId);

  // Update classes (preserve 'open' — it's managed by click events + openFronts set)
  const isOpen = el.classList.contains('open');
  el.className = buildFrontClass(front, waitInFront) + (isOpen ? ' open' : '') + (isSelected ? ' shortcut-selected' : '');

  // Summary line
  const fasCount = el.querySelector('.fas-count');
  if (fasCount) {
    const newText = `${waitInFront} aguardando · ${runInFront} rodando`;
    setText(fasCount, newText);
    cls(fasCount, 'alert', waitInFront > 0);
  }

  // Name (only when not editing)
  if (state.inlineEditSession !== front.sessionName) {
    // If we're switching FROM edit mode back to normal, rebuild the fh-row
    const hasInput = !!el.querySelector('.fname-input');
    if (hasInput) {
      rebuildFhRow(el, front);
    } else {
      const fname = el.querySelector('.fname');
      if (fname) setText(fname, front.name || front.sessionName);

      // aiSuggested badge: add/remove without full rebuild
      const hasConfirmBtn = !!el.querySelector('[data-action="confirm"]');
      if (front.aiSuggested && !hasConfirmBtn) rebuildFhRow(el, front);
      if (!front.aiSuggested && hasConfirmBtn)  rebuildFhRow(el, front);
    }
  }

  // Agents
  patchAgentRows(el.querySelector('.agents'), front);
}

function buildFrontClass(front, waitInFront) {
  return `front ${waitInFront > 0 ? 'has-wait' : 'all-run'}`;
}

function rebuildFhRow(el, front) {
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
    const inputEl = fhRow.querySelector('.fname-input');
    const saveBtn = fhRow.querySelector('[data-action="save"]');
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); state.inlineEditSession = null; render(); }
        if (e.key === 'Enter')  { e.stopPropagation(); saveBtn && saveBtn.click(); }
      });
      setTimeout(() => inputEl.focus(), 0);
    }
    if (saveBtn) saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = el.querySelector('.fname-input');
      const name = input ? input.value.trim() || front.sessionName : front.sessionName;
      const f = state.data.fronts.find(x => x.sessionName === front.sessionName);
      if (f) { f.name = name; f.aiSuggested = false; }
      window.helm.confirmName(front.sessionName, name);
      state.inlineEditSession = null;
      render();
    });
  } else {
    fhRow.innerHTML = `
      <span class="drag-handle" draggable="false">⠿</span>
      <span class="fname">${escapeHtml(displayName)}</span>
      ${front.aiSuggested ? '<button class="name-btn ok" data-action="confirm">✓ ok</button>' : ''}
      <button class="name-btn" data-action="edit">editar</button>
    `;
    const editBtn = fhRow.querySelector('[data-action="edit"]');
    if (editBtn) editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.inlineEditSession = front.sessionName;
      rebuildFhRow(el, front);
    });
    const confirmBtn = fhRow.querySelector('[data-action="confirm"]');
    if (confirmBtn) confirmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.helm.confirmName(front.sessionName, front.name || front.sessionName);
    });
  }
}

function attachFrontEvents(el, front) {
  // Drag-to-reorder
  let dragSrc = null;
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', (e) => {
    dragSrc = el;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.front').forEach(f => f.classList.remove('drag-over'));
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
    const fromIdx = fronts.findIndex(f => f.sessionName === src.dataset.session);
    const toIdx   = fronts.findIndex(f => f.sessionName === el.dataset.session);
    if (fromIdx !== -1 && toIdx !== -1) {
      const [moved] = fronts.splice(fromIdx, 1);
      fronts.splice(toIdx, 0, moved);
      state.frontOrder = fronts.map(f => f.sessionName);
      window.helm.saveFrontOrder(state.frontOrder);
      patchFronts();
    }
  });

  // Toggle open/close on header click
  el.querySelector('.front-head').addEventListener('click', (e) => {
    if (e.target.closest('.name-btn') || e.target.closest('.fname-input')) return;
    el.classList.toggle('open');
    // Persist open state so re-renders don't collapse it
    if (el.classList.contains('open')) state.openFronts.add(front.sessionName);
    else state.openFronts.delete(front.sessionName);
    resizeToContent();
  });

  // Name edit / confirm buttons (in the initial build)
  rebuildFhRow(el, front);
}

// ── Agent rows reconciler ─────────────────────────────────────────────────

function patchAgentRows(agentsEl, front) {
  if (!agentsEl) return;

  // Index existing rows by paneId
  const byPane = new Map();
  for (const row of agentsEl.querySelectorAll('.agent-row[data-pane]')) {
    byPane.set(row.dataset.pane, row);
  }

  // Remove stale
  for (const [id, row] of byPane) {
    if (!front.agents.find(a => a.paneId === id)) {
      row.remove();
      byPane.delete(id);
    }
  }

  // Update or create in order
  front.agents.forEach((agent, idx) => {
    let row = byPane.get(agent.paneId);
    if (!row) {
      row = buildAgentRow(agent, front);
      byPane.set(agent.paneId, row);
    } else {
      patchAgentRow(row, agent);
    }
    const atIdx = agentsEl.children[idx];
    if (atIdx !== row) agentsEl.insertBefore(row, atIdx || null);
  });
}

function buildAgentRow(agent, front) {
  const row = document.createElement('div');
  row.className = `agent-row ${agent.status === 'waiting' ? 'is-wait' : ''}`;
  row.dataset.pane = agent.paneId;
  row.innerHTML = `
    <div class="ar-dot ${agent.status === 'waiting' ? 'wait' : 'run'}"></div>
    <div class="ar-body">
      <div class="ar-top">
        <span class="ar-agent ${agentTag(agent.command)}">${escapeHtml(agentTag(agent.command))}</span>
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

  const preview = row.querySelector('.ar-preview');
  if (preview) {
    cls(preview, 'wait-prev', isWait);
    const newText = escapeHtml(agent.lastOutput || '');
    if (preview.innerHTML !== newText) preview.innerHTML = newText;
  }
}

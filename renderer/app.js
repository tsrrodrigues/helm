const state = {
  data: { fronts: [], activePane: null, activeSessionName: null, summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } },
  open: false,
  selectedPane: null,
  inlineEditSession: null,
  shortcutMode: false,
  focusMode: false,   // true = showing single-agent focus card instead of full panel
  focusAgent: null,    // { agent, front } for focus mode
  frontOrder: [],
  openFronts: new Set(),
  dismissedPanes: new Set(),
  layout: null,  // set on startup from main process (window is always expanded)
  creatingSession: false,
  confirmingDelete: null  // { paneId, sessionName, type: 'window'|'session' }
};

const $ = (id) => document.getElementById(id);
const pill     = $('pill');
const panel    = $('panel');
const frontsEl = $('fronts');

// ── Mouse passthrough ─────────────────────────────────────────────────────
// sendSync ensures cursor switches in same frame (no async lag).
// State tracking avoids spamming IPC on every mousemove.
let _ignoring = true; // starts true — window is always expanded, passthrough on transparent areas
function setIgnoreIfChanged(ignore) {
  if (ignore === _ignoring) return;
  _ignoring = ignore;
  window.helm.setIgnoreMouse(ignore);
}
document.addEventListener('mousemove', (e) => {
  if (_pillDrag) return; // during drag, keep mouse events active
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const overUI = !!el && el !== document.documentElement && el !== document.body;
  setIgnoreIfChanged(!overUI);
});
document.addEventListener('mouseleave', () => {
  if (!_pillDrag) setIgnoreIfChanged(true);
});

// ── Badge drag ───────────────────────────────────────────────────────────
const DRAG_THRESHOLD = 5;
let _pillDrag = null;

pill.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  setIgnoreIfChanged(false);

  if (state.open) {
    // When expanded, click closes — no drag support
    _pillDrag = { startScreenX: e.screenX, startScreenY: e.screenY, isDragging: false, expandedClick: true };
    return;
  }

  _pillDrag = {
    startScreenX: e.screenX,
    startScreenY: e.screenY,
    isDragging: false,
    expandedClick: false
  };
});

document.addEventListener('mousemove', (e) => {
  if (!_pillDrag || _pillDrag.expandedClick) return;
  const dx = e.screenX - _pillDrag.startScreenX;
  const dy = e.screenY - _pillDrag.startScreenY;

  if (!_pillDrag.isDragging) {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    _pillDrag.isDragging = true;
    _pillDrag.lastScreenX = _pillDrag.startScreenX;
    _pillDrag.lastScreenY = _pillDrag.startScreenY;
  }

  const moveDx = e.screenX - _pillDrag.lastScreenX;
  const moveDy = e.screenY - _pillDrag.lastScreenY;
  _pillDrag.lastScreenX = e.screenX;
  _pillDrag.lastScreenY = e.screenY;

  window.helm.moveWindow(moveDx, moveDy);
});

document.addEventListener('mouseup', (e) => {
  if (!_pillDrag) return;
  const wasDragging = _pillDrag.isDragging;
  _pillDrag = null;

  if (wasDragging) {
    // Recalculate window bounds for new pill position, then save
    const layout = window.helm.recalculateBounds();
    if (layout) { state.layout = layout; applyLayout(); }
    window.helm.savePillPosition(null, null);
  } else {
    // Was a click, not a drag
    togglePanel();
  }
  // Always restore focus to previous app after interacting with Helm
  window.helm.refocusPreviousApp();
});

// ── Events ────────────────────────────────────────────────────────────────

pill.addEventListener('keydown', (e) => { if (e.key === 'Enter') togglePanel(); });

document.addEventListener('keydown', (e) => {
  // Skip keyboard nav when editing inline name
  if (state.inlineEditSession) return;

  // Handle create session input
  if (state.creatingSession) {
    if (e.key === 'Escape') { e.preventDefault(); cancelCreateSession(); }
    return; // let input handle Enter etc.
  }

  // Handle focus mode keys
  if (state.focusMode && state.open) {
    if (e.key === 'Enter') { e.preventDefault(); focusNavigate(); }
    else if (e.key === 'x') { e.preventDefault(); focusDismiss(); }
    else if (e.key === 'v') { e.preventDefault(); navigateToEditor(); }
    else if (e.key === 'Tab') { e.preventDefault(); exitFocusMode(); }
    else if (e.key === 'Escape') { e.preventDefault(); togglePanel(false); if (state.shortcutMode) window.helm.blurWindow(); }
    return;
  }

  // Handle delete confirmation
  if (state.confirmingDelete) {
    if (e.key === 'y' || e.key === 'Enter') { e.preventDefault(); executeDelete(); }
    else if (e.key === 'Escape' || e.key === 'n') { e.preventDefault(); cancelDelete(); }
    return;
  }

  // Cmd+number: navigate to Nth agent row
  if (e.metaKey && e.key >= '1' && e.key <= '9' && state.open) {
    e.preventDefault();
    const agents = getNavigableAgents();
    const idx = parseInt(e.key, 10) - 1;
    if (idx < agents.length) {
      navigateTo(agents[idx]);
      togglePanel(false);
      window.helm.blurWindow();
    }
    return;
  }

  if ((e.key === 'j' || e.key === 'ArrowDown') && state.shortcutMode && state.open) {
    e.preventDefault();
    navigateSelection(1);
  } else if ((e.key === 'k' || e.key === 'ArrowUp') && state.shortcutMode && state.open) {
    e.preventDefault();
    navigateSelection(-1);
  } else if (e.key === 'Enter' && state.shortcutMode && state.selectedPane) {
    e.preventDefault();
    const agent = state.selectedPane;
    navigateTo(agent);
    togglePanel(false);
    window.helm.blurWindow();
  } else if (e.key === 'x' && state.shortcutMode && state.selectedPane && state.open) {
    e.preventDefault();
    dismissSelected();
  } else if (e.key === 'd' && state.shortcutMode && state.selectedPane && state.open) {
    e.preventDefault();
    initiateDeleteWindow();
  } else if (e.key === 'D' && state.shortcutMode && state.selectedPane && state.open) {
    e.preventDefault();
    initiateDeleteSession();
  } else if (e.key === 'r' && state.shortcutMode && state.selectedPane && state.open) {
    e.preventDefault();
    renameSelectedAgent();
  } else if (e.key === 'n' && state.shortcutMode && state.selectedPane && state.open) {
    e.preventDefault();
    createWindowForSelected();
  } else if (e.key === 'N' && state.shortcutMode && state.open) {
    e.preventDefault();
    startCreateSession();
  } else if (e.key === 'v' && state.shortcutMode && state.open) {
    e.preventDefault();
    navigateToEditor();
  } else if (e.key === 'Escape' && state.open) {
    e.preventDefault();
    togglePanel(false);
    if (state.shortcutMode) window.helm.blurWindow();
  }
});

window.helm.onActiveApp(({ isTerminal }) => {
  if (!isTerminal && state.open) togglePanel(false);
});

$('add-session-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  startCreateSession();
});

window.helm.onShortcutFired(() => {
  if (state.open) {
    // Toggle: close + blur
    togglePanel(false);
    window.helm.blurWindow();
    return;
  }
  state.shortcutMode = true;
  togglePanel(true);
  preselectAgent();
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

  // Detect newly waiting panes (not previously waiting) for bounce nudge
  let hasNewWaiting = false;
  for (const paneId of nowWaiting) {
    if (!prevWaiting.has(paneId) && !state.dismissedPanes.has(paneId)) { hasNewWaiting = true; break; }
  }

  state.data = next;
  if (!state.inlineEditSession) render();

  // Trigger bounce on pill when a new agent starts waiting
  if (hasNewWaiting) {
    pill.classList.remove('pill-nudge');
    // Force reflow to restart animation
    void pill.offsetWidth;
    pill.classList.add('pill-nudge');
    pill.addEventListener('animationend', function onEnd(e) {
      if (e.animationName === 'pill-bounce') {
        pill.classList.remove('pill-nudge');
        pill.removeEventListener('animationend', onEnd);
      }
    });
  }
});

// Get layout from main process (window is always at expanded size)
state.layout = window.helm.getLayout();
applyLayout();

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

function applyLayout() {
  const l = state.layout;
  if (!l) return;
  pill.style.left = l.pillOffsetX + 'px';
  pill.style.top = l.pillOffsetY + 'px';
  panel.style.left = l.panelOffsetX + 'px';
  panel.style.top = l.panelOffsetY + 'px';
  panel.style.width = l.panelW + 'px';
}

let _animating = false;

function togglePanel(force) {
  const wantOpen = typeof force === 'boolean' ? force : !state.open;
  if (wantOpen === state.open || _animating) return;

  if (wantOpen) {
    // ── OPEN — expand window, then fade in panel ──
    const layout = window.helm.expandToPanel();
    if (layout) { state.layout = layout; applyLayout(); }

    state.open = true;
    panel.classList.remove('closing', 'visible');

    // Check for undismissed waiting agents → enter focus mode
    const focusTarget = getOldestUndismissedWaiting();
    if (focusTarget) {
      state.focusMode = true;
      state.focusAgent = focusTarget;
    } else {
      state.focusMode = false;
      state.focusAgent = null;
      for (const f of (state.data.fronts || [])) state.openFronts.add(f.sessionName);
    }
    render();

    // Fade in panel on next frame
    requestAnimationFrame(() => {
      panel.classList.add('visible');
    });
  } else {
    // ── CLOSE — fade out panel, then collapse window ──
    _animating = true;
    panel.classList.remove('visible');
    panel.classList.add('closing');

    const finishClose = () => {
      if (!_animating) return;
      panel.classList.remove('closing');
      _animating = false;
      state.open = false;
      state.shortcutMode = false;
      state.focusMode = false;
      state.focusAgent = null;
      state.selectedPane = null;
      state.creatingSession = false;
      state.confirmingDelete = null;
      render();

      // Collapse window to pill size — reduces GPU/WindowServer compositing area ~95%
      const layout = window.helm.collapseToPill();
      if (layout) { state.layout = layout; applyLayout(); }
    };

    panel.addEventListener('transitionend', function onEnd(e) {
      if (e.target !== panel) return;
      panel.removeEventListener('transitionend', onEnd);
      finishClose();
    }, { once: true });

    // Safety fallback
    setTimeout(() => { if (_animating) finishClose(); }, 200);
  }
}

function resizeToContent() {
  // No-op: window is always at expanded size, panel scrolls internally
}

function navigateTo(agent) {
  state.dismissedPanes.add(agent.paneId);
  window.helm.navigateToPane(agent.sessionName, agent.windowName, agent.paneId, agent.weztermTabId);
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

// Simple hash → accent index (0-5), deterministic per project name
function projectColor(name) {
  if (!name) return 0;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return ((h % 6) + 6) % 6; // always positive 0-5
}

// ── Focus mode helpers ──────────────────────────────────────────────────

function getOldestUndismissedWaiting() {
  let oldest = null;
  let oldestFront = null;
  for (const f of (state.data.fronts || [])) {
    for (const a of f.agents) {
      if (a.status === 'waiting' && !state.dismissedPanes.has(a.paneId)) {
        if (!oldest || (a.waitingSince && (!oldest.waitingSince || a.waitingSince < oldest.waitingSince))) {
          oldest = a;
          oldestFront = f;
        }
      }
    }
  }
  if (!oldest) return null;
  return { agent: oldest, front: oldestFront };
}

function exitFocusMode() {
  state.focusMode = false;
  state.focusAgent = null;
  for (const f of (state.data.fronts || [])) state.openFronts.add(f.sessionName);
  render();
}

function focusDismiss() {
  if (!state.focusAgent) return;
  state.dismissedPanes.add(state.focusAgent.agent.paneId);
  // Try next waiting
  const next = getOldestUndismissedWaiting();
  if (next) {
    state.focusAgent = next;
  } else {
    exitFocusMode();
    return;
  }
  render();
}

function focusNavigate() {
  if (!state.focusAgent) return;
  const { agent, front } = state.focusAgent;
  state.dismissedPanes.add(agent.paneId);
  window.helm.navigateToPane(front.sessionName, agent.windowName, agent.paneId, front.weztermTabId);
  togglePanel(false);
  window.helm.blurWindow();
}

// ── Keyboard navigation helpers ───────────────────────────────────────

function getNavigableAgents() {
  const list = [];
  for (const f of (state.data.fronts || [])) {
    for (const a of f.agents) {
      list.push({ ...a, sessionName: f.sessionName, weztermTabId: f.weztermTabId });
    }
  }
  return list;
}

function preselectAgent() {
  const agents = getNavigableAgents();
  if (!agents.length) { state.selectedPane = null; return; }

  const activeSession = state.data?.activeSessionName;
  const activeAgents = activeSession ? agents.filter(a => a.sessionName === activeSession) : [];

  // Prefer waiting agent from active session (oldest first, not dismissed)
  const oldest = state.data?.summary?.oldestWaiting;
  if (oldest && activeAgents.length) {
    const match = activeAgents.find(a => a.paneId === oldest.paneId && !state.dismissedPanes.has(a.paneId));
    if (match) { state.selectedPane = match; ensureSelectedVisible(); return; }
  }

  // Fallback: first waiting from active session (not dismissed)
  const activeWaiting = activeAgents.find(a => a.status === 'waiting' && !state.dismissedPanes.has(a.paneId));
  if (activeWaiting) { state.selectedPane = activeWaiting; ensureSelectedVisible(); return; }

  // Fallback: first agent from active session
  if (activeAgents.length) { state.selectedPane = activeAgents[0]; ensureSelectedVisible(); return; }

  // Fallback: first waiting globally (not dismissed)
  const firstWaiting = agents.find(a => a.status === 'waiting' && !state.dismissedPanes.has(a.paneId));
  if (firstWaiting) { state.selectedPane = firstWaiting; ensureSelectedVisible(); return; }

  // Fallback: first agent
  state.selectedPane = agents[0];
  ensureSelectedVisible();
}

function navigateSelection(dir) {
  const agents = getNavigableAgents();
  if (!agents.length) return;

  if (!state.selectedPane) {
    state.selectedPane = agents[0];
  } else {
    const idx = agents.findIndex(a => a.paneId === state.selectedPane.paneId);
    const next = (idx + dir + agents.length) % agents.length;
    state.selectedPane = agents[next];
  }

  ensureSelectedVisible();
  render();
}

function ensureSelectedVisible() {
  if (!state.selectedPane) return;
  // Auto-expand the front containing the selected agent
  for (const f of (state.data.fronts || [])) {
    if (f.agents.some(a => a.paneId === state.selectedPane.paneId)) {
      state.openFronts.add(f.sessionName);
      break;
    }
  }
  // Scroll into view after render
  requestAnimationFrame(() => {
    const row = document.querySelector(`.agent-row[data-pane="${state.selectedPane?.paneId}"]`);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function dismissSelected() {
  if (!state.selectedPane) return;
  const agents = getNavigableAgents();
  const idx = agents.findIndex(a => a.paneId === state.selectedPane.paneId);

  state.dismissedPanes.add(state.selectedPane.paneId);

  // Advance selection to next agent (or previous, or null)
  if (agents.length > 1) {
    const next = idx + 1 < agents.length ? idx + 1 : idx - 1;
    state.selectedPane = agents[next];
  } else {
    state.selectedPane = null;
  }
  render();
}

// ── AI rename agent ──────────────────────────────────────────────────────

async function renameSelectedAgent() {
  if (!state.selectedPane) return;
  const paneId = state.selectedPane.paneId;

  // Visual feedback
  const row = document.querySelector(`.agent-row[data-pane="${paneId}"]`);
  const nameEl = row?.querySelector('.ar-name');
  const prevText = nameEl?.textContent;
  if (nameEl) nameEl.textContent = 'renomeando...';

  const result = await window.helm.renameAgent(paneId);
  if (!result.ok) {
    console.error('[helm] rename failed:', result.error);
    if (nameEl) nameEl.textContent = prevText || '';
  }
  // On success, daemon broadcasts new state — render will pick it up
}

// ── Navigate to editor (nvim) ──────────────────────────────────────────────

function navigateToEditor() {
  let editorPane = null;
  let editorFront = null;

  // Prefer editor pane from the selected agent's front
  if (state.selectedPane) {
    const front = state.data.fronts.find(f => f.agents.some(a => a.paneId === state.selectedPane.paneId));
    if (front && front.editorPanes?.length > 0) {
      editorPane = front.editorPanes[0];
      editorFront = front;
    }
  }

  // Fallback: first front with editor panes
  if (!editorPane) {
    for (const f of (state.data.fronts || [])) {
      if (f.editorPanes?.length > 0) {
        editorPane = f.editorPanes[0];
        editorFront = f;
        break;
      }
    }
  }

  if (editorPane && editorFront) {
    window.helm.navigateToPane(editorFront.sessionName, editorPane.windowName, editorPane.paneId, editorFront.weztermTabId);
    togglePanel(false);
    window.helm.blurWindow();
  }
}

// ── Create session ────────────────────────────────────────────────────────

function startCreateSession() {
  state.creatingSession = true;
  render();
  setTimeout(() => {
    const input = document.querySelector('.create-session-input');
    if (input) input.focus();
  }, 0);
}

function cancelCreateSession() {
  state.creatingSession = false;
  render();
}

async function submitCreateSession() {
  const input = document.querySelector('.create-session-input');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  state.creatingSession = false;
  togglePanel(false);
  const result = await window.helm.createSession(name);
  if (!result.ok) console.error('[helm] create-session failed:', result.error);
}

// ── Delete session/window ────────────────────────────────────────────────

function initiateDeleteWindow() {
  if (!state.selectedPane) return;
  const agent = state.selectedPane;
  const front = state.data.fronts.find(f => f.agents.some(a => a.paneId === agent.paneId));
  if (!front) return;
  state.confirmingDelete = { paneId: agent.paneId, sessionName: front.sessionName, type: 'window' };
  render();
}

function initiateDeleteSession() {
  if (!state.selectedPane) return;
  const agent = state.selectedPane;
  const front = state.data.fronts.find(f => f.agents.some(a => a.paneId === agent.paneId));
  if (!front) return;
  state.confirmingDelete = { paneId: agent.paneId, sessionName: front.sessionName, type: 'session' };
  render();
}

async function createWindowForSelected() {
  if (!state.selectedPane) return;
  const agent = state.selectedPane;
  const front = state.data.fronts.find(f => f.agents.some(a => a.paneId === agent.paneId));
  if (!front) return;
  togglePanel(false);
  const result = await window.helm.createWindow(front.sessionName);
  if (!result.ok) console.error('[helm] create-window failed:', result.error);
}

async function executeDelete() {
  if (!state.confirmingDelete) return;
  const { paneId, sessionName, type } = state.confirmingDelete;
  state.confirmingDelete = null;

  // Advance selection away from deleted item
  const agents = getNavigableAgents();
  const idx = agents.findIndex(a => a.paneId === paneId);
  if (agents.length > 1) {
    const next = idx + 1 < agents.length ? idx + 1 : idx - 1;
    state.selectedPane = agents[next];
  } else {
    state.selectedPane = null;
  }

  render();

  let result;
  if (type === 'session') {
    result = await window.helm.killSession(sessionName);
  } else {
    result = await window.helm.killWindow(paneId);
  }
  if (!result.ok) console.error(`[helm] kill-${type} failed:`, result.error);
}

function cancelDelete() {
  state.confirmingDelete = null;
  render();
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

  setText($('pill-text'), effectiveWaiting > 0 ? String(effectiveWaiting) : '');

  const wasNudge = pill.classList.contains('pill-nudge');
  pill.className = effectiveWaiting > 0 ? 'pill has-waiting' : 'pill all-ok';
  if (wasNudge && effectiveWaiting > 0) pill.classList.add('pill-nudge');

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

  const hint = $('shortcut-hint');
  hint.hidden = !state.shortcutMode && !state.focusMode;
  if (state.focusMode) {
    setText(hint, 'Enter ir · x dispensar · v nvim · Tab ver tudo · Esc fechar');
  } else if (state.shortcutMode) {
    if (state.confirmingDelete) {
      setText(hint, 'Enter/y confirmar · Esc/n cancelar');
    } else {
      setText(hint, 'j/k navegar · Enter ir · x dispensar · r renomear · v nvim · n window · d/D deletar · N sessão');
    }
  }

  // Focus mode: show single-agent focus card
  if (state.focusMode && state.focusAgent) {
    renderFocusCard();
    return;
  }

  // Normal mode: hide focus card, show fronts
  const existingFocus = $('focus-card');
  if (existingFocus) existingFocus.remove();
  frontsEl.style.display = '';
  $('create-area').style.display = '';
  document.querySelector('.pf').style.display = '';
  document.querySelector('.ph').style.display = '';

  reconcileFronts();
  renderCreateArea();
}

// ── Create area renderer ──────────────────────────────────────────────────

function renderCreateArea() {
  const area = $('create-area');
  if (!area) return;
  if (!state.creatingSession) {
    area.innerHTML = '';
    return;
  }
  if (area.querySelector('.create-session-input')) return; // already rendered
  area.innerHTML = `
    <div class="create-session-row">
      <input class="create-session-input" placeholder="nome da sessão" maxlength="64" />
      <button class="create-btn">criar</button>
    </div>
  `;
  const input = area.querySelector('.create-session-input');
  const btn = area.querySelector('.create-btn');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitCreateSession(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelCreateSession(); }
  });
  btn.addEventListener('click', () => submitCreateSession());
  setTimeout(() => input.focus(), 0);
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
  const hasEditors = (front.editorPanes || []).length > 0;
  const accentIdx = projectColor(front.projectDir);

  const summaryParts = [];
  if (front.agents.length > 0) summaryParts.push(`${effectiveWait} aguardando · ${run} rodando`);
  if (hasEditors) summaryParts.push('nvim');
  const summaryText = summaryParts.join(' · ');

  el.className = frontClasses(effectiveWait, accentIdx) + (state.openFronts.has(front.sessionName) ? ' open' : '');

  el.innerHTML = `
    <div class="front-head">
      <div class="fh-row">
        <span class="drag-handle" draggable="false">⠿</span>
        <span class="fname">${escapeHtml(front.name || front.sessionName)}</span>
        ${front.aiSuggested ? '<button class="name-btn ok" data-action="confirm">✓ ok</button>' : ''}
        <button class="name-btn" data-action="edit">editar</button>
      </div>
      ${front.projectDir ? `<div class="project-name">${escapeHtml(front.projectDir)}</div>` : ''}
      <div class="fagents-summary">
        ${effectiveWait ? '<div class="fas-dot wait"></div>' : ''}
        ${run  ? '<div class="fas-dot run"></div>' : ''}
        <span class="fas-count ${effectiveWait ? 'alert' : ''}">${summaryText}</span>
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
  const accentIdx = projectColor(front.projectDir);

  el.className = frontClasses(effectiveWait, accentIdx) + (isOpen ? ' open' : '');

  // Update project name
  let projEl = el.querySelector('.project-name');
  if (front.projectDir) {
    if (!projEl) {
      projEl = document.createElement('div');
      projEl.className = 'project-name';
      const fhRow = el.querySelector('.fh-row');
      if (fhRow) fhRow.parentNode.insertBefore(projEl, fhRow.nextSibling);
    }
    setText(projEl, front.projectDir);
  } else if (projEl) {
    projEl.remove();
  }

  // Summary
  const hasEditors = (front.editorPanes || []).length > 0;
  const summaryParts = [];
  if (front.agents.length > 0) summaryParts.push(`${effectiveWait} aguardando · ${run} rodando`);
  if (hasEditors) summaryParts.push('nvim');
  const summaryText = summaryParts.join(' · ');

  const fasCount = el.querySelector('.fas-count');
  if (fasCount) {
    setText(fasCount, summaryText);
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

function frontClasses(effectiveWaitCount, accentIdx) {
  return `front ${effectiveWaitCount > 0 ? 'has-wait' : 'all-run'} accent-${accentIdx ?? 0}`;
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

  // Add window button at the end
  let addBtn = agentsEl.querySelector('.add-window-btn');
  if (!addBtn) {
    addBtn = document.createElement('button');
    addBtn.className = 'add-window-btn';
    addBtn.textContent = '+ nova window';
    addBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      togglePanel(false);
      const result = await window.helm.createWindow(front.sessionName);
      if (!result.ok) console.error('[helm] create-window failed:', result.error);
    });
    agentsEl.appendChild(addBtn);
  }
  // Keep it last
  if (addBtn !== agentsEl.lastElementChild) agentsEl.appendChild(addBtn);
}

function getAgentGlobalIndex(paneId) {
  const agents = getNavigableAgents();
  const idx = agents.findIndex(a => a.paneId === paneId);
  return idx >= 0 && idx < 9 ? idx + 1 : null;
}

function createAgentRow(agent, front) {
  const row = document.createElement('div');
  const isWait = agent.status === 'waiting';
  const isDismissed = isWait && state.dismissedPanes.has(agent.paneId);
  const isSelected = state.selectedPane?.paneId === agent.paneId;
  const isConfirming = state.confirmingDelete?.paneId === agent.paneId;
  row.className = `agent-row${isWait ? ' is-wait' : ''}${isDismissed ? ' is-dismissed' : ''}${isSelected ? ' selected' : ''}${isConfirming ? ' confirming-delete' : ''}`;
  row.dataset.pane = agent.paneId;
  const tag = agentTag(agent.command);
  const num = getAgentGlobalIndex(agent.paneId);
  const confirmType = state.confirmingDelete?.type === 'session' ? 'sessão' : 'window';
  row.innerHTML = `
    ${num ? `<span class="ar-num">${num}</span>` : ''}
    <div class="ar-dot ${isWait ? 'wait' : 'run'}"></div>
    <div class="ar-body">
      <div class="ar-top">
        <span class="ar-agent ${tag}">${escapeHtml(tag)}</span>
        <span class="ar-time">${formatElapsed(agent.interactionStartedAt)}</span>
      </div>
      <div class="ar-name">${escapeHtml(agent.task || agent.windowName)}</div>
    </div>
    <div class="ar-dismiss" data-pane="${agent.paneId}" title="marcar como visto">✓</div>
    <div class="ar-delete" data-pane="${agent.paneId}" title="deletar">✕</div>
    <div class="ar-confirm-delete">deletar ${confirmType}? <button class="confirm-yes">sim</button> <button class="confirm-no">não</button></div>
    <div class="ar-nav">ir →</div>
  `;
  row.querySelector('.ar-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    state.dismissedPanes.add(agent.paneId);
    render();
  });
  row.querySelector('.ar-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    // Select this agent first, then initiate delete window
    state.selectedPane = { ...agent, sessionName: front.sessionName, weztermTabId: front.weztermTabId };
    initiateDeleteWindow();
  });
  row.querySelector('.confirm-yes').addEventListener('click', (e) => {
    e.stopPropagation();
    executeDelete();
  });
  row.querySelector('.confirm-no').addEventListener('click', (e) => {
    e.stopPropagation();
    cancelDelete();
  });
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.confirmingDelete) return;
    navigateTo({ ...agent, sessionName: front.sessionName, weztermTabId: front.weztermTabId });
  });
  return row;
}

function patchAgentRow(row, agent, front) {
  const isWait = agent.status === 'waiting';
  const isDismissed = isWait && state.dismissedPanes.has(agent.paneId);
  const isSelected = state.selectedPane?.paneId === agent.paneId;
  const isConfirming = state.confirmingDelete?.paneId === agent.paneId;
  cls(row, 'is-wait', isWait);
  cls(row, 'is-dismissed', isDismissed);
  cls(row, 'selected', isSelected);
  cls(row, 'confirming-delete', isConfirming);

  const dot = row.querySelector('.ar-dot');
  if (dot) dot.className = `ar-dot ${isWait ? 'wait' : 'run'}`;

  const nameEl = row.querySelector('.ar-name');
  if (nameEl) setText(nameEl, agent.task || agent.windowName);

  const time = row.querySelector('.ar-time');
  if (time) setText(time, formatElapsed(agent.interactionStartedAt));

  // Update number badge
  const num = getAgentGlobalIndex(agent.paneId);
  const numEl = row.querySelector('.ar-num');
  if (num) {
    if (numEl) { setText(numEl, String(num)); }
    else {
      const badge = document.createElement('span');
      badge.className = 'ar-num';
      badge.textContent = num;
      row.insertBefore(badge, row.firstChild);
    }
  } else if (numEl) {
    numEl.remove();
  }
}

// ── Focus card renderer ────────────────────────────────────────────────────

function renderFocusCard() {
  // Hide normal panel content
  frontsEl.style.display = 'none';
  $('create-area').style.display = 'none';
  document.querySelector('.pf').style.display = 'none';
  document.querySelector('.ph').style.display = 'none';

  const { agent, front } = state.focusAgent;
  const accentIdx = projectColor(front.projectDir);
  const tag = agentTag(agent.command);
  const elapsed = formatElapsed(agent.waitingSince);
  const summary = agent.waitingSummary || '';
  const lastLine = agent.lastOutput || '';

  let card = $('focus-card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'focus-card';
    panel.insertBefore(card, frontsEl);
  }

  card.className = `focus-card accent-${accentIdx}`;
  card.innerHTML = `
    <div class="fc-header">
      <div class="fc-project">${escapeHtml(front.projectDir || front.sessionName)}</div>
      <div class="fc-elapsed">${elapsed ? `esperando ${escapeHtml(elapsed)}` : 'aguardando'}</div>
    </div>
    <div class="fc-task">${escapeHtml(agent.task || agent.windowName)}</div>
    <div class="fc-agent">${escapeHtml(tag)}</div>
    ${summary ? `<div class="fc-summary">${escapeHtml(summary)}</div>` : ''}
    ${lastLine ? `<div class="fc-prompt">${escapeHtml(lastLine)}</div>` : ''}
    <div class="fc-actions">
      <button class="fc-btn fc-go">Enter ir</button>
      <button class="fc-btn fc-dismiss">x dispensar</button>
      <button class="fc-btn fc-all">Tab ver tudo</button>
    </div>
  `;

  card.querySelector('.fc-go').addEventListener('click', (e) => { e.stopPropagation(); focusNavigate(); });
  card.querySelector('.fc-dismiss').addEventListener('click', (e) => { e.stopPropagation(); focusDismiss(); });
  card.querySelector('.fc-all').addEventListener('click', (e) => { e.stopPropagation(); exitFocusMode(); });
}

// ── Discrete blink for waiting dots (no CSS animation = no 60fps GPU compositing) ──
// Toggles opacity every 1.5s — causes exactly 1 repaint per toggle instead of continuous
let _blinkOn = true;
setInterval(() => {
  _blinkOn = !_blinkOn;
  const opacity = _blinkOn ? '1' : '0.3';
  for (const dot of document.querySelectorAll('.pdot.wait, .fas-dot.wait, .ar-dot.wait')) {
    dot.style.opacity = opacity;
  }
}, 1500);

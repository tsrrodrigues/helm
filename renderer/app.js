const state = {
  data: { fronts: [], activePane: null, activeSessionName: null, summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } },
  open: false,
  selectedPane: null,
  expandedPane: null,       // paneId or null — which agent row is expanded
  inlineEditSession: null,
  shortcutMode: false,
  frontOrder: [],
  dismissedPanes: new Set(),
  layout: null,  // set on startup from main process (window is always expanded)
  creatingSession: false,
  confirmingDelete: null,  // { paneId, sessionName, type: 'window'|'session' }
  inlineEditAgent: null    // paneId being manually renamed
};

const $ = (id) => document.getElementById(id);


const pill       = $('pill');
const panel      = $('panel');
const rowsEl     = $('rows');



// Curated glyph set — high-contrast Unicode symbols for agent badges
const GLYPHS = ['⚙', '⚡', '◆', '★', '■', '△', '⚒', '☷', '✦', '✱'];

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

// ── Badge click (pill is fixed, no drag) ─────────────────────────────────
let _pillDrag = null; // kept for setIgnoreIfChanged guard

pill.addEventListener('click', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  setIgnoreIfChanged(false);
  togglePanel();
  window.helm.refocusPreviousApp();
});

// ── Events ────────────────────────────────────────────────────────────────

pill.addEventListener('keydown', (e) => { if (e.key === 'Enter') togglePanel(); });

document.addEventListener('keydown', (e) => {
  // Skip keyboard nav when editing inline name
  if (state.inlineEditSession || state.inlineEditAgent) return;

  // Handle create session input
  if (state.creatingSession) {
    if (e.key === 'Escape') { e.preventDefault(); cancelCreateSession(); }
    return; // let input handle Enter etc.
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

  // Ctrl+1..9: select response card option (Ctrl+last = open write mode)
  if (e.ctrlKey && e.key >= '1' && e.key <= '9' && state.open && state.expandedPane) {
    e.preventDefault();
    const row = document.querySelector(`.row[data-pane="${state.expandedPane}"]`);
    const options = row?.querySelectorAll('.rc-option');
    const idx = parseInt(e.key, 10) - 1;
    if (options && options.length > 0) {
      if (idx < options.length) {
        // Click the option
        const text = options[idx].dataset.optionText;
        if (text) sendResponseToAgent(state.expandedPane, text);
      } else {
        // Beyond last option: open write mode
        const writeBox = row?.querySelector('.rc-write');
        if (writeBox) {
          writeBox.classList.add('visible');
          writeBox.querySelector('.rc-write-input')?.focus();
        }
      }
    } else {
      // No options: open write mode
      const writeBox = row?.querySelector('.rc-write');
      if (writeBox) {
        writeBox.classList.add('visible');
        writeBox.querySelector('.rc-write-input')?.focus();
      }
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
  } else if (e.key === 'R' && state.shortcutMode && state.selectedPane && state.open) {
    e.preventDefault();
    manualRenameAgent();
  } else if (e.key === 'f' && state.shortcutMode && state.selectedPane && state.open) {
    e.preventDefault();
    forkSelectedAgent();
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
    if (state.expandedPane) {
      // First Escape: collapse expanded card
      state.expandedPane = null;
      render();
    } else {
      // Second Escape: close panel
      togglePanel(false);
      if (state.shortcutMode) window.helm.blurWindow();
    }
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

  // Build waitingSince maps for detecting new waiting cycles
  const prevWaitingSince = new Map();
  for (const f of (state.data.fronts || [])) {
    for (const a of f.agents) { if (a.status === 'waiting') prevWaitingSince.set(a.paneId, a.waitingSince); }
  }
  const nowWaitingSince = new Map();
  for (const f of (next.fronts || [])) {
    for (const a of f.agents) { if (a.status === 'waiting') nowWaitingSince.set(a.paneId, a.waitingSince); }
  }

  // Clear dismiss for panes that:
  // 1. Left waiting (transitioned to running/idle)
  // 2. Started a NEW waiting cycle (waitingSince changed = agent ran and came back)
  for (const paneId of state.dismissedPanes) {
    if (!nowWaiting.has(paneId)) {
      state.dismissedPanes.delete(paneId);
    } else if (prevWaitingSince.get(paneId) !== nowWaitingSince.get(paneId)) {
      state.dismissedPanes.delete(paneId);
    }
  }

  // Detect newly waiting panes (not previously waiting) for bounce nudge
  let hasNewWaiting = false;
  for (const paneId of nowWaiting) {
    if (!prevWaiting.has(paneId) && !state.dismissedPanes.has(paneId)) { hasNewWaiting = true; break; }
  }

  state.data = next;

  // Clear navigation override when daemon catches up to the same active pane
  if (_lastNavigatedPane && next.activePane === _lastNavigatedPane) {
    _lastNavigatedPane = null;
  }

  if (!state.inlineEditSession && !state.inlineEditAgent) render();

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

  // Dynamic rows max-height: panelH minus header, footer, and padding
  // so content grows without scroll until screen is full
  if (l.panelH > 0) {
    // panel padding (16+14) + header .ph (~32) + footer .pf (~44) ≈ 106
    const rowsMaxH = l.panelH - 106;
    rowsEl.style.maxHeight = Math.max(100, rowsMaxH) + 'px';
    rowsEl.style.overflowY = 'auto';
  } else {
    rowsEl.style.maxHeight = '';
    rowsEl.style.overflowY = '';
  }
}

let _animating = false;

function togglePanel(force) {
  const wantOpen = typeof force === 'boolean' ? force : !state.open;
  if (wantOpen === state.open || _animating) return;

  if (wantOpen) {
    // ── OPEN — CSS-only fade in (window stays at expanded size) ──
    state.open = true;
    panel.classList.remove('closing', 'visible');

    // Resolve where the user effectively IS (Helm navigation > daemon poll)
    const activePaneId = getActivePane();
    const activeAgent = activePaneId ? findAgentByPane(activePaneId) : null;
    const currentSession = activeAgent?.sessionName || state.data.activeSessionName;

    // Auto-expand oldest undismissed waiting agent from current session, or fall back to active agent
    const focusTarget = getOldestUndismissedWaiting(currentSession);
    if (focusTarget) {
      state.expandedPane = focusTarget.agent.paneId;
      state.selectedPane = { ...focusTarget.agent, sessionName: focusTarget.front.sessionName, weztermTabId: focusTarget.front.weztermTabId };
    } else if (activeAgent) {
      state.selectedPane = activeAgent;
      state.expandedPane = activeAgent.paneId;
    } else {
      state.selectedPane = null;
      state.expandedPane = null;
    }
    render();

    // Fade in panel on next frame
    requestAnimationFrame(() => {
      panel.classList.add('visible');
    });
  } else {
    // ── CLOSE — CSS-only fade out (window stays at expanded size) ──
    _animating = true;
    panel.classList.remove('visible');
    panel.classList.add('closing');

    const finishClose = () => {
      if (!_animating) return;
      panel.classList.remove('closing');
      _animating = false;
      state.open = false;
      state.shortcutMode = false;
      state.expandedPane = null;
      state.selectedPane = null;
      state.creatingSession = false;
      state.confirmingDelete = null;
      render();
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

// Last agent the user navigated to via Helm — persists until daemon confirms
let _lastNavigatedPane = null;

function getActivePane() {
  return _lastNavigatedPane || state.data.activePane;
}

function navigateTo(agent) {
  state.dismissedPanes.add(agent.paneId);
  _lastNavigatedPane = agent.paneId;
  window.helm.navigateToPane(agent.sessionName, agent.windowName, agent.paneId, agent.weztermTabId);
  render();
}

function agentTag(command) {
  const c = String(command || '').toLowerCase();
  if (c.includes('codex')) return 'codex';
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

// Format bullet points: ensure each • starts on its own line
function formatBullets(text) {
  const escaped = escapeHtml(text);
  // Put each bullet on its own line (handle inline bullets like "• foo • bar")
  return escaped.replace(/\s*•\s*/g, '\n• ').trim();
}

// Simple hash → accent index (0-5), deterministic per project name
function projectColor(name) {
  if (!name) return 0;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return ((h % 6) + 6) % 6; // always positive 0-5
}

// Collision-aware glyph assignment — each active agent gets a unique glyph
const glyphAssignments = new Map(); // paneId → glyphIndex (stable across renders)

function assignGlyphs(allPaneIds) {
  // Remove stale assignments
  for (const [id] of glyphAssignments) {
    if (!allPaneIds.includes(id)) glyphAssignments.delete(id);
  }

  const usedIndices = new Set();
  for (const [, idx] of glyphAssignments) usedIndices.add(idx);

  for (const paneId of allPaneIds) {
    if (glyphAssignments.has(paneId)) continue;

    // Hash for deterministic starting point
    let h = 0;
    for (let i = 0; i < paneId.length; i++) h = ((h << 5) - h + paneId.charCodeAt(i)) | 0;
    let idx = ((h % GLYPHS.length) + GLYPHS.length) % GLYPHS.length;

    // Find next available if collision
    let attempts = 0;
    while (usedIndices.has(idx) && attempts < GLYPHS.length) {
      idx = (idx + 1) % GLYPHS.length;
      attempts++;
    }

    glyphAssignments.set(paneId, idx);
    usedIndices.add(idx);
  }
}

function glyphForAgent(paneId) {
  const idx = glyphAssignments.get(paneId);
  if (idx != null) return GLYPHS[idx];
  // Fallback for calls before assignGlyphs (shouldn't happen)
  let h = 0;
  for (let i = 0; i < paneId.length; i++) h = ((h << 5) - h + paneId.charCodeAt(i)) | 0;
  return GLYPHS[((h % GLYPHS.length) + GLYPHS.length) % GLYPHS.length];
}

// Look up agent from current state by paneId (avoids stale closures in event handlers)
function findAgentByPane(paneId) {
  for (const f of (state.data.fronts || [])) {
    for (const a of f.agents) {
      if (a.paneId === paneId) return { ...a, sessionName: f.sessionName, weztermTabId: f.weztermTabId };
    }
  }
  return null;
}

// ── Focus helpers ────────────────────────────────────────────────────────

function getOldestUndismissedWaiting(filterSession) {
  let oldest = null;
  let oldestFront = null;
  for (const f of (state.data.fronts || [])) {
    if (filterSession && f.sessionName !== filterSession) continue;
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

function preselectAgent(freshPane) {
  const agents = getNavigableAgents();
  if (!agents.length) { state.selectedPane = null; state.expandedPane = null; return; }

  let selected = null;

  // Top priority: fresh pane ID from tmux (queried at shortcut time, always accurate)
  if (freshPane) {
    selected = agents.find(a => a.paneId === freshPane);
  }

  if (!selected) {
    const activeSession = state.data?.activeSessionName;
    const activeAgents = activeSession ? agents.filter(a => a.sessionName === activeSession) : [];

    // Prefer waiting agent from active session (oldest first, not dismissed)
    const oldest = state.data?.summary?.oldestWaiting;
    if (!selected && oldest && activeAgents.length) {
      selected = activeAgents.find(a => a.paneId === oldest.paneId && !state.dismissedPanes.has(a.paneId));
    }

    // Fallback: first waiting from active session (not dismissed)
    if (!selected) {
      selected = activeAgents.find(a => a.status === 'waiting' && !state.dismissedPanes.has(a.paneId));
    }

    // Fallback: the active window's pane in this session
    if (!selected) {
      const activeFront = state.data?.fronts?.find(f => f.sessionName === activeSession);
      if (activeFront?.activePaneId && activeAgents.length) {
        selected = activeAgents.find(a => a.paneId === activeFront.activePaneId);
      }
    }

    // Fallback: first agent from active session
    if (!selected && activeAgents.length) {
      selected = activeAgents[0];
    }

    // Fallback: first waiting globally (not dismissed)
    if (!selected) {
      selected = agents.find(a => a.status === 'waiting' && !state.dismissedPanes.has(a.paneId));
    }

    // Fallback: first agent
    if (!selected) {
      selected = agents[0];
    }
  }

  state.selectedPane = selected;
  state.expandedPane = selected ? selected.paneId : null;
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

  state.expandedPane = state.selectedPane.paneId;
  ensureSelectedVisible();
  render();
}

function ensureSelectedVisible() {
  if (!state.selectedPane) return;
  // Scroll into view after render
  requestAnimationFrame(() => {
    const row = document.querySelector(`.row[data-pane="${state.selectedPane?.paneId}"]`);
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
    state.expandedPane = state.selectedPane.paneId;
  } else {
    state.selectedPane = null;
    state.expandedPane = null;
  }
  render();
}

// ── AI rename agent ──────────────────────────────────────────────────────

async function renameSelectedAgent() {
  if (!state.selectedPane) return;
  const paneId = state.selectedPane.paneId;

  // Block re-renders while waiting for AI rename
  state.inlineEditAgent = paneId;

  // Visual feedback
  const row = document.querySelector(`.row[data-pane="${paneId}"]`);
  const taskEl = row?.querySelector('.r-task');
  const prevText = taskEl?.textContent;
  if (taskEl) taskEl.textContent = 'renomeando...';

  const result = await window.helm.renameAgent(paneId);
  state.inlineEditAgent = null;
  if (!result.ok) {
    console.error('[helm] rename failed:', result.error);
    if (taskEl) taskEl.textContent = prevText || '';
  }
  // On success, daemon broadcasts new state — render will pick it up
  render();
}

// ── Manual rename agent ─────────────────────────────────────────────────────

function manualRenameAgent() {
  if (!state.selectedPane) return;
  const paneId = state.selectedPane.paneId;
  const row = document.querySelector(`.row[data-pane="${paneId}"]`);
  const taskEl = row?.querySelector('.r-task');
  if (!taskEl) return;

  state.inlineEditAgent = paneId;
  const currentName = taskEl.textContent;
  let done = false;

  taskEl.innerHTML = `<input class="ar-name-input" value="${escapeHtml(currentName)}" />`;
  const input = taskEl.querySelector('.ar-name-input');
  input.focus();
  input.select();

  const finish = (name) => {
    if (done) return;
    done = true;
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
    taskEl.textContent = name || currentName;
    if (name && name !== currentName) {
      // Keep inlineEditAgent locked until daemon confirms the new name
      // (prevents patchAgentRowV5 from overwriting with the old name)
      window.helm.manualRenameAgent(paneId, name).then(() => {
        // Update state.data immediately so renders show the new name
        // (daemon broadcast may not have arrived yet)
        for (const f of (state.data.fronts || [])) {
          for (const a of f.agents) {
            if (a.paneId === paneId) { a.task = name; break; }
          }
        }
        state.inlineEditAgent = null;
      }).catch(err => {
        console.error('[helm] manual rename failed:', err);
        state.inlineEditAgent = null;
      });
    } else {
      state.inlineEditAgent = null;
    }
  };

  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim()); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
  };

  const onBlur = () => finish(null);

  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
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
  window.helm.blurWindow();
  const result = await window.helm.createWindow(front.sessionName, front.weztermTabId);
  if (!result.ok) console.error('[helm] create-window failed:', result.error);
}

async function forkSelectedAgent() {
  if (!state.selectedPane) return;
  // Re-read agent from current state (selectedPane may be a stale snapshot)
  const front = state.data.fronts.find(f => f.agents.some(a => a.paneId === state.selectedPane.paneId));
  if (!front) return;
  const agent = front.agents.find(a => a.paneId === state.selectedPane.paneId);
  if (!agent || !agent.claudeSessionId) return;
  togglePanel(false);
  window.helm.blurWindow();
  const result = await window.helm.forkSession(front.sessionName, agent.claudeSessionId, agent.panePath, front.weztermTabId);
  if (!result.ok) console.error('[helm] fork-session failed:', result.error);
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
    state.expandedPane = state.selectedPane.paneId;
  } else {
    state.selectedPane = null;
    state.expandedPane = null;
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
  // Assign unique glyphs before any rendering
  const allPaneIds = [];
  for (const f of (state.data.fronts || [])) {
    for (const a of f.agents) allPaneIds.push(a.paneId);
  }
  assignGlyphs(allPaneIds);

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

  // Pill glyphs — waiting left, running right
  const waitGlyphs = [];
  const runGlyphs = [];
  for (const f of (state.data.fronts || [])) {
    const colorIdx = projectColor(f.projectDir);
    for (const a of f.agents) {
      const glyph = glyphForAgent(a.paneId);
      const isWait = a.status === 'waiting' && !state.dismissedPanes.has(a.paneId);
      const html = `<div class="pill-glyph ${isWait ? 'wait' : 'run'} g-${colorIdx}">${glyph}</div>`;
      if (isWait) waitGlyphs.push(html); else runGlyphs.push(html);
    }
  }
  $('pill-waiting').innerHTML = waitGlyphs.join('');
  $('pill-running').innerHTML = runGlyphs.join('');

  // Active glyph — shows which agent is in the current terminal
  renderActiveGlyph();
  renderBreadcrumb();

  setText($('sum-fronts'), String(state.data.summary?.total || 0));
  setText($('sum-agents'), String(state.data.summary?.totalAgents || 0));
  setText($('sum-waiting'), String(effectiveWaiting));

  const hint = $('shortcut-hint');
  hint.hidden = !state.shortcutMode;
  if (state.shortcutMode) {
    if (state.confirmingDelete) {
      setText(hint, 'Enter/y confirmar · Esc/n cancelar');
    } else {
      setText(hint, 'j/k navegar · Enter ir · Ctrl+N opção · x dispensar · r/R renomear · f fork · v nvim · n window · d/D deletar · N sessão');
    }
  }

  // Reconcile flat agent rows
  reconcileRows();
  renderCreateArea();

  // Position breadcrumb below pill — window is always expanded, use simple offset
  const bc = $('breadcrumb');
  if (bc && !bc.hidden) {
    const pillLeft = parseInt(pill.style.left) || 0;
    const pillW = pill.offsetWidth;
    const bcW = bc.offsetWidth;
    bc.style.left = Math.round(pillLeft + (pillW - bcW) / 2) + 'px';
    bc.style.top = ((parseInt(pill.style.top) || 0) + 48) + 'px';
  }
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


// ── Active watermark updater ─────────────────────────────────────────────

function renderActiveGlyph() {
  const activePane = getActivePane();
  if (!activePane) {
    window.helm.updateWatermark({ glyph: null, colorIdx: 0 });
    return;
  }

  let activeAgent = null;
  let activeFront = null;
  for (const f of (state.data.fronts || [])) {
    for (const a of f.agents) {
      if (a.paneId === activePane) { activeAgent = a; activeFront = f; break; }
    }
    if (activeAgent) break;
  }

  if (!activeAgent || !activeFront) {
    window.helm.updateWatermark({ glyph: null, colorIdx: 0 });
    return;
  }

  const colorIdx = projectColor(activeFront.projectDir);
  const glyph = glyphForAgent(activeAgent.paneId);
  window.helm.updateWatermark({ glyph, colorIdx });
}

// ── Breadcrumb (current agent indicator below pill) ──────────────────────

function renderBreadcrumb() {
  const bc = $('breadcrumb');
  if (!bc) return;

  // Find selected agent (or fall back to active pane)
  let agent = state.selectedPane;
  let front = null;
  if (agent) {
    for (const f of (state.data.fronts || [])) {
      if (f.agents.some(a => a.paneId === agent.paneId)) { front = f; break; }
    }
  }
  if (!agent || !front) {
    const activePane = getActivePane();
    for (const f of (state.data.fronts || [])) {
      for (const a of f.agents) {
        if (a.paneId === activePane) { agent = a; front = f; break; }
      }
      if (agent) break;
    }
  }

  if (!agent || !front) {
    bc.hidden = true;
    return;
  }

  bc.hidden = false;

  const colorIdx = projectColor(front.projectDir);
  const glyph = glyphForAgent(agent.paneId);
  const isWait = agent.status === 'waiting';
  const taskName = agent.task || '';

  const glyphEl = $('bc-glyph');
  glyphEl.textContent = glyph;
  for (let i = 0; i < 6; i++) glyphEl.classList.toggle(`g-${i}`, i === colorIdx);

  const sessEl = $('bc-session');
  setText(sessEl, front.sessionName);
  for (let i = 0; i < 6; i++) sessEl.classList.toggle(`c-${i}`, i === colorIdx);
  setText($('bc-agent'), taskName || front.sessionName);

  const statusEl = $('bc-status');
  statusEl.className = 'bc-status ' + (isWait ? 'wait' : 'run');
}

// ── Flat rows reconciler ─────────────────────────────────────────────────

function reconcileRows() {
  // Build flat agent list preserving front order
  const allAgents = [];
  for (const f of (state.data.fronts || [])) {
    for (const a of f.agents) {
      allAgents.push({ agent: a, front: f });
    }
  }

  // Index existing row elements
  const byPane = new Map();
  for (const el of rowsEl.querySelectorAll('.row[data-pane]')) {
    byPane.set(el.dataset.pane, el);
  }

  // Remove stale
  for (const [id, el] of byPane) {
    if (!allAgents.find(({ agent }) => agent.paneId === id)) {
      el.remove();
      byPane.delete(id);
    }
  }

  // Update or create in order
  allAgents.forEach(({ agent, front }, idx) => {
    let row = byPane.get(agent.paneId);
    if (!row) {
      row = createAgentRowV5(agent, front);
      byPane.set(agent.paneId, row);
    } else {
      patchAgentRowV5(row, agent, front);
    }
    if (rowsEl.children[idx] !== row) {
      rowsEl.insertBefore(row, rowsEl.children[idx] || null);
    }
  });
}

function createAgentRowV5(agent, front) {
  const row = document.createElement('div');
  const isWait = agent.status === 'waiting';
  const isDismissed = isWait && state.dismissedPanes.has(agent.paneId);
  const isSelected = state.selectedPane?.paneId === agent.paneId;
  const isExpanded = state.expandedPane === agent.paneId;
  const isConfirming = state.confirmingDelete?.paneId === agent.paneId;
  const colorIdx = projectColor(front.projectDir);
  const glyph = glyphForAgent(agent.paneId);

  row.className = 'row'
    + ` accent-${colorIdx} tint-${colorIdx}`
    + (isWait ? ' is-wait' : '')
    + (isDismissed ? ' is-dismissed' : '')
    + (isSelected ? ' selected' : '')
    + (isExpanded ? ' expanded' : '')
    + (isConfirming ? ' confirming-delete' : '');
  row.dataset.pane = agent.paneId;

  const projectDir = front.projectDir || front.sessionName;
  const projectName = projectDir.split('/').pop() || projectDir;
  const sdotClass = isWait ? 'wait' : 'run';
  const confirmType = state.confirmingDelete?.type === 'session' ? 'sessão' : 'window';

  const agentNum = getAgentGlobalIndex(agent.paneId);
  const numBadge = agentNum ? `<span class="g-num">${agentNum}</span>` : '';
  const taskName = agent.task || '';
  const taskSepStyle = taskName ? '' : ' style="display:none"';
  const branchLabel = agent.worktreeBranch ? agent.worktreeBranch.split('/').pop() : '';
  const branchHtml = branchLabel ? `<span class="r-branch" title="${escapeHtml(agent.worktreeBranch)}">⎇ ${escapeHtml(branchLabel)}</span>` : '<span class="r-branch"></span>';
  const taskHtml = `<span class="r-sep"${taskSepStyle}>\u203A</span><span class="r-task">${escapeHtml(taskName)}</span>`;

  row.innerHTML = `
    <div class="glyph g-${colorIdx}">${numBadge}${glyph}<span class="sdot ${sdotClass}"></span></div>
    <div class="r-body">
      <div class="r-main">
        <span class="r-project c-${colorIdx}">${escapeHtml(projectName)}</span>
        ${taskHtml}
        ${branchHtml}
        <span class="r-time">${formatElapsed(agent.interactionStartedAt)}</span>
      </div>
      <div class="response-card"></div>
    </div>
    <div class="ar-delete" data-pane="${agent.paneId}" title="deletar">\u2715</div>
    <div class="ar-confirm-delete">deletar ${confirmType}? <button class="confirm-yes">sim</button> <button class="confirm-no">não</button></div>
  `;

  // Populate response card if expanded
  if (isExpanded) {
    renderResponseCard(row.querySelector('.response-card'), agent, front);
  }

  // Event listeners — use findAgentByPane to avoid stale closures
  row.querySelector('.ar-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    const a = findAgentByPane(row.dataset.pane);
    if (a) { state.selectedPane = a; initiateDeleteWindow(); }
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
    if (e.target.closest('.ar-delete, .ar-confirm-delete')) return;
    const a = findAgentByPane(row.dataset.pane);
    if (a) navigateTo(a);
  });

  return row;
}

function patchAgentRowV5(row, agent, front) {
  const isWait = agent.status === 'waiting';
  const isDismissed = isWait && state.dismissedPanes.has(agent.paneId);
  const isSelected = state.selectedPane?.paneId === agent.paneId;
  const isExpanded = state.expandedPane === agent.paneId;
  const isConfirming = state.confirmingDelete?.paneId === agent.paneId;
  const colorIdx = projectColor(front.projectDir);

  // Update accent/tint classes
  for (let i = 0; i < 6; i++) {
    cls(row, `accent-${i}`, i === colorIdx);
    cls(row, `tint-${i}`, i === colorIdx);
  }
  cls(row, 'is-wait', isWait);
  cls(row, 'is-dismissed', isDismissed);
  cls(row, 'selected', isSelected);
  cls(row, 'expanded', isExpanded);
  cls(row, 'confirming-delete', isConfirming);

  // Update glyph color
  const glyphEl = row.querySelector('.glyph');
  if (glyphEl) {
    for (let i = 0; i < 6; i++) cls(glyphEl, `g-${i}`, i === colorIdx);
  }

  // Update shortcut number
  const numEl = row.querySelector('.g-num');
  const agentNum = getAgentGlobalIndex(agent.paneId);
  if (numEl) {
    setText(numEl, agentNum ? String(agentNum) : '');
  } else if (agentNum && glyphEl) {
    const span = document.createElement('span');
    span.className = 'g-num';
    span.textContent = String(agentNum);
    glyphEl.insertBefore(span, glyphEl.firstChild);
  }

  // Update status dot
  const sdot = row.querySelector('.sdot');
  if (sdot) sdot.className = `sdot ${isWait ? 'wait' : 'run'}`;

  // Update project name
  const projEl = row.querySelector('.r-project');
  if (projEl) {
    const projectDir = front.projectDir || front.sessionName;
    const projectName = projectDir.split('/').pop() || projectDir;
    setText(projEl, projectName);
    for (let i = 0; i < 6; i++) cls(projEl, `c-${i}`, i === colorIdx);
  }

  // Update task name (skip during inline edit) — allow blank
  if (state.inlineEditAgent !== agent.paneId) {
    const taskEl = row.querySelector('.r-task');
    if (taskEl && !taskEl.querySelector('.ar-name-input')) {
      const taskName = agent.task || '';
      setText(taskEl, taskName);
      // Show/hide separator before task name
      const taskSep = row.querySelector('.r-sep');
      if (taskSep) taskSep.style.display = taskName ? '' : 'none';
    }
  }

  // Update branch indicator
  const branchEl = row.querySelector('.r-branch');
  if (branchEl) {
    const branchLabel = agent.worktreeBranch ? agent.worktreeBranch.split('/').pop() : '';
    setText(branchEl, branchLabel ? `⎇ ${branchLabel}` : '');
    if (agent.worktreeBranch) branchEl.title = agent.worktreeBranch;
  }

  // Update time
  const timeEl = row.querySelector('.r-time');
  if (timeEl) setText(timeEl, formatElapsed(agent.interactionStartedAt));

  // Update response card
  const cardEl = row.querySelector('.response-card');
  if (cardEl) {
    if (isExpanded) {
      // Re-render if card is empty (first expand) or responseCard data changed
      const prevType = cardEl.dataset.rcType || '';
      const prevHero = cardEl.dataset.rcHero || '';
      const curType = agent.responseCard?.type || '';
      const curHero = agent.responseCard?.hero || '';
      if (!cardEl.hasChildNodes() || prevType !== curType || prevHero !== curHero) {
        renderResponseCard(cardEl, agent, front);
        cardEl.dataset.rcType = curType;
        cardEl.dataset.rcHero = curHero;
      }
    } else {
      // Clear card when collapsed
      if (cardEl.hasChildNodes()) {
        cardEl.innerHTML = '';
        delete cardEl.dataset.rcType;
        delete cardEl.dataset.rcHero;
      }
    }
  }
}

// ── Response card renderer ────────────────────────────────────────────────

function renderResponseCard(cardEl, agent, front) {
  const isWait = agent.status === 'waiting';
  const rc = agent.responseCard; // structured data from daemon (or null)
  const summary = agent.waitingSummary || agent.lastOutput || '';

  let heroHtml = '';
  let optionsHtml = '';
  let contextHtml = '';
  let kpisHtml = '';

  if (rc) {
    // ── Structured response card from daemon ──
    if (rc.type === 'question' && rc.options?.length) {
      heroHtml = `
        <div class="rc-hero question">
          <div class="rc-hero-text">${formatBullets(rc.hero || 'Escolha uma opção')}</div>
        </div>
      `;
      optionsHtml = `<div class="rc-options">
        ${rc.options.map((opt, i) => `
          <div class="rc-option" data-option-idx="${i}" data-option-text="${escapeHtml(opt.label)}">
            <span class="opt-num">${i + 1}</span>
            <span class="opt-label">${escapeHtml(opt.label)}</span>
          </div>
        `).join('')}
      </div>`;
    } else if (rc.type === 'permission') {
      heroHtml = `
        <div class="rc-hero permission">
          <div class="rc-hero-label">permissão</div>
          <div class="rc-hero-text">${escapeHtml(rc.hero || 'Permissão necessária')}</div>
          ${rc.command ? `<div class="rc-command"><code>${escapeHtml(rc.command)}</code></div>` : ''}
        </div>
      `;
      optionsHtml = `<div class="rc-options">
        <div class="rc-option rc-approve" data-option-idx="0" data-option-text="y">
          <span class="opt-num">1</span>
          <span class="opt-label">Aprovar</span>
        </div>
        <div class="rc-option rc-deny" data-option-idx="1" data-option-text="n">
          <span class="opt-num">2</span>
          <span class="opt-label">Negar</span>
        </div>
      </div>`;
    } else {
      // type === 'response'
      heroHtml = `
        <div class="rc-hero response">
          <div class="rc-hero-text">${formatBullets(rc.hero || summary || 'Trabalhando...')}</div>
        </div>
      `;
    }

    // KPIs from structured data
    if (rc.kpis?.length) {
      kpisHtml = `<div class="rc-kpis">
        ${rc.kpis.map(k => `<span class="rc-kpi ${k.color || ''}"><span class="kpi-num">${escapeHtml(k.num)}</span><span class="kpi-label">${escapeHtml(k.label)}</span></span>`).join('')}
      </div>`;
    }
  } else {
    // ── Fallback: no structured data ──
    if (isWait) {
      heroHtml = `
        <div class="rc-hero question">
          <div class="rc-hero-text">${formatBullets(summary || 'Aguardando sua interação')}</div>
        </div>
      `;
    } else {
      heroHtml = `
        <div class="rc-hero response">
          <div class="rc-hero-text">${formatBullets(summary || 'Trabalhando...')}</div>
        </div>
      `;
    }
  }

  const actionsHtml = `
    <div class="rc-actions">
      <button class="rc-btn" data-action="terminal">Ver no terminal</button>
      <button class="rc-btn primary" data-action="write">Nova instrução</button>
    </div>
    <div class="rc-write">
      <textarea class="rc-write-input" placeholder="Escreva sua instrução..." rows="1"></textarea>
      <div class="rc-write-submit">
        <button class="rc-btn primary" data-action="send">Enviar</button>
      </div>
    </div>
  `;

  cardEl.innerHTML = heroHtml + optionsHtml + contextHtml + kpisHtml + actionsHtml;

  // ── Event listeners ──

  // Option clicks — send the option text (or index+1 as string)
  for (const opt of cardEl.querySelectorAll('.rc-option')) {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = opt.dataset.optionText;
      if (text) sendResponseToAgent(cardEl.closest('.row').dataset.pane, text);
    });
  }

  // "Ver no terminal" — navigate directly
  cardEl.querySelector('[data-action="terminal"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const a = findAgentByPane(cardEl.closest('.row').dataset.pane);
    if (a) { navigateTo(a); togglePanel(false); if (state.shortcutMode) window.helm.blurWindow(); }
  });

  // "Nova instrução" — toggle write field
  cardEl.querySelector('[data-action="write"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const writeBox = cardEl.querySelector('.rc-write');
    writeBox.classList.toggle('visible');
    if (writeBox.classList.contains('visible')) {
      writeBox.querySelector('.rc-write-input').focus();
    }
  });

  // "Enviar" button
  cardEl.querySelector('[data-action="send"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = cardEl.querySelector('.rc-write-input');
    const text = input?.value.trim();
    if (!text) return;
    sendResponseToAgent(cardEl.closest('.row').dataset.pane, text);
  });

  // Prevent response card clicks from navigating the row
  cardEl.addEventListener('click', (e) => e.stopPropagation());

  // Textarea: Enter sends, Escape closes write, prevent keyboard shortcut leaking
  const textarea = cardEl.querySelector('.rc-write-input');
  if (textarea) {
    textarea.addEventListener('click', (e) => e.stopPropagation());
    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = textarea.value.trim();
        if (text) sendResponseToAgent(cardEl.closest('.row').dataset.pane, text);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const writeBox = cardEl.querySelector('.rc-write');
        writeBox.classList.remove('visible');
        textarea.blur();
      }
    });
  }
}

function extractKeywords(text) {
  if (!text) return [];
  // Split by bullets, newlines, colons, semicolons
  const parts = text.split(/[•\n:;]+/).map(s => s.trim()).filter(s => s.length > 2 && s.length < 50);
  return parts.slice(0, 8);
}

async function sendResponseToAgent(paneId, text) {
  // Send text to the agent via tmux send-keys
  try {
    await window.helm.sendKeys(paneId, text);
  } catch (err) {
    console.error('[helm] send-keys failed:', err);
    return;
  }

  // Show sent animation
  const row = document.querySelector(`.row[data-pane="${paneId}"]`);
  const card = row?.querySelector('.response-card');
  if (card) {
    card.innerHTML = '<div class="sent-indicator" style="padding: 12px 14px;">\u2713 Enviado</div>';
  }

  // After animation, move to next waiting or close panel
  setTimeout(() => {
    state.expandedPane = null;

    // Auto-navigate to next waiting agent
    const next = getOldestUndismissedWaiting();
    if (next) {
      state.expandedPane = next.agent.paneId;
      state.selectedPane = { ...next.agent, sessionName: next.front.sessionName, weztermTabId: next.front.weztermTabId };
    } else {
      togglePanel(false);
      if (state.shortcutMode) window.helm.blurWindow();
    }
    render();
  }, 800);
}

function getAgentGlobalIndex(paneId) {
  const agents = getNavigableAgents();
  const idx = agents.findIndex(a => a.paneId === paneId);
  return idx >= 0 && idx < 9 ? idx + 1 : null;
}

// ── Discrete blink for waiting dots (no CSS animation = no 60fps GPU compositing) ──
// Toggles a CSS class on body every 1.5s — 1 repaint per toggle.
// Class-based approach avoids stale inline style.opacity when dots transition .wait → .run
setInterval(() => {
  document.body.classList.toggle('blink-dim');
}, 1500);

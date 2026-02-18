const state = {
  data: { fronts: [], summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } },
  open: false,
  selectedPane: null,
  inlineEditSession: null,
  shortcutMode: false
};

const $ = (id) => document.getElementById(id);
const pill = $('pill');
const panel = $('panel');
const frontsEl = $('fronts');

pill.addEventListener('click', () => togglePanel());
pill.addEventListener('keydown', (e) => { if (e.key === 'Enter') togglePanel(); });

// Hover tracking: libera mouse events só quando está sobre a UI, ignora no resto
document.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const overUI = el && (el.closest('.pill') || el.closest('.panel'));
  window.helm.setIgnoreMouse(!overUI);
});
document.addEventListener('mouseleave', () => {
  window.helm.setIgnoreMouse(true);
});

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
  state.data = next || state.data;
  render();
});

window.helm.getState().then((initial) => {
  if (initial) state.data = initial;
  render();
}).catch(() => render());

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
  // Dois frames: primeiro o DOM renderiza, depois medimos o tamanho real
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

function render() {
  const waiting = state.data.summary?.waiting || 0;
  $('pill-text').textContent = `${waiting} aguardando`;

  const dots = [];
  const runCount = Math.min(4, state.data.summary?.totalAgents || 0);
  const waitCount = Math.min(2, waiting);
  for (let i = 0; i < waitCount; i++) dots.push('<div class="pdot wait"></div>');
  for (let i = 0; i < Math.max(1, runCount - waitCount); i++) dots.push('<div class="pdot run"></div>');
  $('pill-dots').innerHTML = dots.join('');

  $('sum-fronts').textContent = state.data.summary?.total || 0;
  $('sum-agents').textContent = state.data.summary?.totalAgents || 0;
  $('sum-waiting').textContent = waiting;

  $('shortcut-hint').hidden = !state.shortcutMode;

  frontsEl.innerHTML = '';
  // Drag state
  let dragSrc = null;

  for (const front of state.data.fronts || []) {
    const waitInFront = front.agents.filter((a) => a.status === 'waiting').length;
    const runInFront = front.agents.filter((a) => a.status === 'running').length;
    const isSelected = state.selectedPane && front.agents.some((a) => a.paneId === state.selectedPane.paneId);

    const frontEl = document.createElement('div');
    frontEl.className = `front ${waitInFront ? 'has-wait' : 'all-run'} ${state.open ? 'open' : ''} ${isSelected ? 'shortcut-selected' : ''}`;
    frontEl.setAttribute('draggable', 'true');
    frontEl.dataset.session = front.sessionName;

    frontEl.addEventListener('dragstart', (e) => {
      dragSrc = frontEl;
      frontEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    frontEl.addEventListener('dragend', () => {
      frontEl.classList.remove('dragging');
      document.querySelectorAll('.front').forEach(f => f.classList.remove('drag-over'));
    });
    frontEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (dragSrc && dragSrc !== frontEl) frontEl.classList.add('drag-over');
    });
    frontEl.addEventListener('dragleave', () => frontEl.classList.remove('drag-over'));
    frontEl.addEventListener('drop', (e) => {
      e.preventDefault();
      frontEl.classList.remove('drag-over');
      if (!dragSrc || dragSrc === frontEl) return;
      // Reorder in state
      const fronts = state.data.fronts;
      const fromIdx = fronts.findIndex(f => f.sessionName === dragSrc.dataset.session);
      const toIdx   = fronts.findIndex(f => f.sessionName === frontEl.dataset.session);
      if (fromIdx !== -1 && toIdx !== -1) {
        const [moved] = fronts.splice(fromIdx, 1);
        fronts.splice(toIdx, 0, moved);
        render();
      }
      dragSrc = null;
    });

    const showEdit = state.inlineEditSession === front.sessionName;
    const displayName = front.name || front.sessionName;

    frontEl.innerHTML = `
      <div class="front-head">
        <div class="fh-row">
          <span class="drag-handle" draggable="false">⠿</span>
        ${showEdit ? `
            <div class="fname-edit">
              <input class="fname-input" value="${escapeHtml(displayName)}" data-session="${escapeHtml(front.sessionName)}" />
              <button class="name-btn ok" data-action="save">✓ ok</button>
            </div>
          ` : `
            <span class="fname">${escapeHtml(displayName)}</span>
            ${front.aiSuggested ? '<button class="name-btn ok" data-action="confirm">✓ ok</button>' : ''}
            <button class="name-btn" data-action="edit">editar</button>
          `}
        </div>
        <div class="fagents-summary">
          ${waitInFront ? '<div class="fas-dot wait"></div>' : ''}
          ${runInFront ? '<div class="fas-dot run"></div>' : ''}
          <span class="fas-count ${waitInFront ? 'alert' : ''}">${waitInFront} aguardando · ${runInFront} rodando</span>
        </div>
      </div>
      <div class="fdiv"></div>
      <div class="agents"></div>
    `;

    frontEl.querySelector('.front-head').addEventListener('click', (e) => {
      if (e.target.closest('.name-btn') || e.target.closest('.fname-input')) return;
      frontEl.classList.toggle('open');
      resizeToContent();
    });

    const agentsEl = frontEl.querySelector('.agents');
    for (const agent of front.agents) {
      const row = document.createElement('div');
      row.className = `agent-row ${agent.status === 'waiting' ? 'is-wait' : ''}`;
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
      agentsEl.appendChild(row);
    }

    const editBtn = frontEl.querySelector('[data-action="edit"]');
    if (editBtn) editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.inlineEditSession = front.sessionName;
      render();
    });

    const confirmBtn = frontEl.querySelector('[data-action="confirm"]');
    if (confirmBtn) confirmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.helm.confirmName(front.sessionName, displayName);
    });

    const saveBtn = frontEl.querySelector('[data-action="save"]');
    if (saveBtn) saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = frontEl.querySelector('.fname-input');
      const name = input.value.trim() || front.sessionName;
      window.helm.confirmName(front.sessionName, name);
      state.inlineEditSession = null;
      render();
    });

    frontsEl.appendChild(frontEl);
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

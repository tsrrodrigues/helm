const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 7373;
const POLL_MS = 3000;
const WAIT_STABLE_MS = 8000;

const HOME = os.homedir();
const HELM_DIR = path.join(HOME, '.helm');
const NAMES_FILE = path.join(HELM_DIR, 'session-names.json');
const ANTHROPIC_KEY_FILE = path.join(HOME, '.config', 'anthropic', 'api_key');

const IGNORE_COMMANDS = new Set(['vim', 'nvim', 'less', 'man']);
const AGENT_COMMANDS = new Set(['claude', 'codex', 'node']);
const IDLE_SHELLS = new Set(['bash', 'zsh', 'fish']);
const RUN_PATTERNS = [/✻/, /◆/, /Thinking/i, /Reading/i, /Writing/i, /Analyzing/i, /Running/i];
const WAIT_HINTS = [/Awaiting/i, /Done/i, /✔/, /How should/i, />\s*$/, /❯\s*$/, /\$\s*$/, /\?\s*$/];

const paneMemory = new Map();
let aiSuggestedSessions = new Set();
let cachedState = { fronts: [], summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };

function ensureFiles() {
  if (!fs.existsSync(HELM_DIR)) fs.mkdirSync(HELM_DIR, { recursive: true });
  if (!fs.existsSync(NAMES_FILE)) fs.writeFileSync(NAMES_FILE, '{}\n', 'utf8');
}

function readNames() {
  ensureFiles();
  try {
    return JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function writeNames(names) {
  ensureFiles();
  fs.writeFileSync(NAMES_FILE, JSON.stringify(names, null, 2), 'utf8');
}

function execCmd(cmd, args = [], timeout = 3500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function listTmuxPanes() {
  const fmt = '#{session_name}\t#{window_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{pane_title}\t#{pane_current_path}';
  const res = await execCmd('tmux', ['list-panes', '-a', '-F', fmt]);
  if (!res.ok) return null;

  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sessionName, windowName, paneId, command, panePid, paneTitle, panePath] = line.split('\t');
      return {
        sessionName,
        windowName,
        paneId,
        command: (command || '').trim(),
        panePid,
        paneTitle: paneTitle || '',
        panePath: panePath || ''
      };
    })
    .filter((p) => p.paneId && p.sessionName);
}

async function capturePane(paneId) {
  const res = await execCmd('tmux', ['capture-pane', '-p', '-t', paneId, '-S', '-3']);
  if (!res.ok) return '';
  return res.stdout.trimEnd();
}

function looksWaiting(lastLine) {
  if (!lastLine) return false;
  return WAIT_HINTS.some((rx) => rx.test(lastLine.trim()));
}

function statusForPane(pane, output, now) {
  const command = pane.command.toLowerCase();
  const lastLine = output.split('\n').filter(Boolean).pop() || '';

  if (IGNORE_COMMANDS.has(command)) return null;

  if (IDLE_SHELLS.has(command)) {
    return { status: 'idle', waitingSince: null };
  }

  const prev = paneMemory.get(pane.paneId);
  const changed = !prev || prev.output !== output;

  let waitingSince = prev?.waitingSince || null;
  let status = 'running';

  if (RUN_PATTERNS.some((rx) => rx.test(output)) || changed) {
    status = 'running';
    waitingSince = null;
  }

  const stableFor = prev ? now - prev.lastChangedAt : 0;
  const isAgentProcess = AGENT_COMMANDS.has(command);

  if (isAgentProcess && !changed && stableFor >= WAIT_STABLE_MS && looksWaiting(lastLine)) {
    status = 'waiting';
    waitingSince = waitingSince || (prev?.waitingSince || now - stableFor);
  }

  paneMemory.set(pane.paneId, {
    output,
    lastChangedAt: changed ? now : (prev?.lastChangedAt || now),
    waitingSince: status === 'waiting' ? waitingSince : null
  });

  return { status, waitingSince: status === 'waiting' ? waitingSince : null };
}

async function weztermMap(sessions) {
  const res = await execCmd('wezterm', ['cli', 'list', '--format', 'json']);
  if (!res.ok) return {};

  try {
    const items = JSON.parse(res.stdout || '[]');
    const map = {};
    for (const sessionName of sessions) {
      const match = items.find((item) => {
        const blob = JSON.stringify(item).toLowerCase();
        return blob.includes(sessionName.toLowerCase());
      });
      if (match && (match.tab_id || match.tabId)) {
        map[sessionName] = match.tab_id || match.tabId;
      }
    }
    return map;
  } catch {
    return {};
  }
}

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try {
    return fs.readFileSync(ANTHROPIC_KEY_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function cleanTaskName(raw, fallback) {
  const text = String(raw || '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return fallback;
  return text.replace(/^['"`]|['"`]$/g, '').slice(0, 40);
}

async function suggestName(sessionName, panePath, command) {
  const key = getApiKey();
  if (!key) return sessionName;

  const prompt = `Suggest a short task name (2-4 words, title case) for a terminal session.\nDirectory: ${panePath || '(unknown)'}\nCommand: ${command || '(unknown)'}\nSession: ${sessionName}\nReply with ONLY the task name, nothing else.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 20,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) return sessionName;
    const data = await response.json();
    const maybe = data?.content?.[0]?.text;
    return cleanTaskName(maybe, sessionName);
  } catch {
    return sessionName;
  }
}

async function buildState() {
  const panes = await listTmuxPanes();
  if (!panes) {
    return { fronts: [], summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };
  }

  const now = Date.now();
  const names = readNames();
  const sessions = [...new Set(panes.map((p) => p.sessionName))];
  const tabMap = await weztermMap(sessions);

  for (const s of sessions) {
    if (!names[s] && !aiSuggestedSessions.has(s)) {
      aiSuggestedSessions.add(s);
      const samplePane = panes.find((p) => p.sessionName === s);
      suggestName(s, samplePane?.panePath, samplePane?.command).then((suggested) => {
        const currentNames = readNames();
        if (!currentNames[s]) {
          currentNames[s] = suggested;
          writeNames(currentNames);
        }
      });
    }
  }

  const frontsMap = new Map();
  for (const pane of panes) {
    const output = await capturePane(pane.paneId);
    const state = statusForPane(pane, output, now);
    if (!state) continue;

    if (!frontsMap.has(pane.sessionName)) {
      frontsMap.set(pane.sessionName, {
        name: names[pane.sessionName] || pane.sessionName,
        sessionName: pane.sessionName,
        weztermTabId: tabMap[pane.sessionName] || null,
        aiSuggested: !!(names[pane.sessionName] && names[pane.sessionName] !== pane.sessionName),
        agents: []
      });
    }

    const taskLine = output.split('\n').find((l) => /(claude|codex)/i.test(l)) || output.split('\n')[0] || '';
    const lastOutput = output.split('\n').filter(Boolean).pop() || '';

    frontsMap.get(pane.sessionName).agents.push({
      paneId: pane.paneId,
      windowName: pane.windowName,
      command: pane.command,
      task: taskLine.trim().slice(0, 80),
      status: state.status,
      lastOutput: lastOutput.trim().slice(0, 140),
      waitingSince: state.waitingSince
    });
  }

  const fronts = [...frontsMap.values()].map((f) => ({
    ...f,
    agents: f.agents.sort((a, b) => {
      const rank = { waiting: 0, running: 1, idle: 2 };
      return rank[a.status] - rank[b.status];
    })
  }));

  const waitingAgents = fronts.flatMap((f) => f.agents.map((a) => ({ ...a, frontName: f.name }))).filter((a) => a.status === 'waiting');
  waitingAgents.sort((a, b) => (a.waitingSince || Infinity) - (b.waitingSince || Infinity));

  const summary = {
    total: fronts.length,
    totalAgents: fronts.reduce((n, f) => n + f.agents.length, 0),
    waiting: waitingAgents.length,
    oldestWaiting: waitingAgents[0]
      ? {
          frontName: waitingAgents[0].frontName,
          paneId: waitingAgents[0].paneId,
          waitingSince: waitingAgents[0].waitingSince
        }
      : null
  };

  return { fronts, summary };
}

const wss = new WebSocket.Server({ port: PORT });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify(cachedState));
});

function broadcast(state) {
  const payload = JSON.stringify(state);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function hasChanged(next, prev) {
  return JSON.stringify(next) !== JSON.stringify(prev);
}

async function tick() {
  try {
    const next = await buildState();
    if (hasChanged(next, cachedState)) {
      cachedState = next;
      broadcast(cachedState);
    }
  } catch (e) {
    const fallback = { fronts: [], summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };
    if (hasChanged(fallback, cachedState)) {
      cachedState = fallback;
      broadcast(cachedState);
    }
  }
}

ensureFiles();
setInterval(tick, POLL_MS);
tick();

console.log(`Helm daemon running on ws://localhost:${PORT}`);

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 7373;
const POLL_MS = 2000;
const WAIT_STABLE_MS = 6000;

const HOME = os.homedir();
const HELM_DIR = path.join(HOME, '.helm');
const NAMES_FILE = path.join(HELM_DIR, 'session-names.json');
const CONFIRMED_FILE = path.join(HELM_DIR, 'confirmed-names.json');
const ANTHROPIC_KEY_FILE = path.join(HOME, '.config', 'anthropic', 'api_key');

const IGNORE_COMMANDS = new Set(['vim', 'nvim', 'less', 'man']);
const AGENT_COMMANDS = new Set(['claude', 'codex', 'node']);
const IDLE_SHELLS = new Set(['bash', 'zsh', 'fish']);

// ── Status detection patterns ─────────────────────────────────────────────
// All patterns are checked ONLY against the last N lines (not full scrollback)

// Spinner symbols that indicate active processing (checked on last 4 lines)
const RUN_SYMBOLS = [/✻/, /◆/, /⠋/, /⠙/, /⠸/, /⠴/, /⠦/, /⠇/];
// Text indicators of active work (checked on last 4 lines)
const RUN_TEXT = [/\bThinking\.\.\./i, /\bReading\.\.\./i, /\bWriting\.\.\./i, /\bAnalyzing\.\.\./i, /\bSearching\.\.\./i, /\bCompiling\.\.\./i];

// Explicit wait prompts — if the LAST LINE matches any of these, status is immediately 'waiting'
const WAIT_PROMPTS = [
  /^>\s*$/,                    // Claude Code bare prompt ">"  or "> "
  /^❯\s*$/,                   // zsh-style prompt
  /^\$\s*$/,                  // bash prompt
  /\?\s*$/,                   // question prompt
  /accept edits/i,            // Claude Code: ">> accept edits on (shift+tab to cycle)"
  /shift\+tab to cycle/i,     // Claude Code edit acceptance
  /ctrl\+[a-z] to/i,         // Claude Code action hints like "ctrl+t to hide tasks"
  /to exit plan mode/i,       // Claude Code plan mode
  /\(y\/n\)/i,                // yes/no confirm
  /\(Y\/n\)/i,
  /Press Enter/i,             // generic press-enter
  /Awaiting\s/i,              // "Awaiting input" etc
  /How should/i,              // Claude "How should I proceed?"
  /What would you/i,          // "What would you like..."
  /Do you want/i,             // "Do you want to..."
];

// ── State ─────────────────────────────────────────────────────────────────
const paneMemory = new Map();
const aiSuggestedSessions = new Set();
let cachedState = { fronts: [], summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };
let cachedStateJson = '{}';

// ── File helpers ──────────────────────────────────────────────────────────

function ensureFiles() {
  if (!fs.existsSync(HELM_DIR)) fs.mkdirSync(HELM_DIR, { recursive: true });
  if (!fs.existsSync(NAMES_FILE)) fs.writeFileSync(NAMES_FILE, '{}\n', 'utf8');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); } catch { return {}; }
}

function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('[helm] writeJson:', e.message); }
}

function readNames()      { ensureFiles(); return readJson(NAMES_FILE); }
function writeNames(n)    { ensureFiles(); writeJson(NAMES_FILE, n); }
function readConfirmed()  { return readJson(CONFIRMED_FILE); }
function writeConfirmed(sessionName) {
  ensureFiles();
  const c = readConfirmed();
  c[sessionName] = true;
  writeJson(CONFIRMED_FILE, c);
}

// ── WezTerm binary detection ──────────────────────────────────────────────
const WEZTERM_PATHS = [
  '/Applications/WezTerm.app/Contents/MacOS/wezterm',
  '/opt/homebrew/bin/wezterm',
  '/usr/local/bin/wezterm',
  'wezterm'
];

let weztermBin = null;
for (const p of WEZTERM_PATHS) {
  try { if (p.startsWith('/') && fs.existsSync(p)) { weztermBin = p; break; } } catch {}
}
if (!weztermBin) weztermBin = 'wezterm';

const sysEnv = {
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':')
};

function execCmd(cmd, args = [], timeout = 3500) {
  const bin = cmd === 'wezterm' ? weztermBin : cmd;
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env: sysEnv }, (error, stdout, stderr) => {
      if (error && cmd !== 'wezterm') console.error(`[helm] ${cmd} ${args.join(' ')}:`, error.message);
      resolve({ ok: !error, error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ── tmux helpers ──────────────────────────────────────────────────────────

async function listTmuxPanes() {
  const fmt = '#{session_name}\t#{window_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{pane_title}\t#{pane_current_path}';
  const res = await execCmd('tmux', ['list-panes', '-a', '-F', fmt]);
  if (!res.ok) return null;

  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sessionName, windowName, paneId, command, panePid, paneTitle, panePath] = line.split('\t');
      return { sessionName, windowName, paneId, command: (command || '').trim(), panePid, paneTitle: paneTitle || '', panePath: panePath || '' };
    })
    .filter((p) => p.paneId && p.sessionName);
}

// Capture only the last N visible lines of a pane (not scrollback)
async function capturePane(paneId) {
  // -S -20 = start 20 lines before end of visible area. Enough context, avoids stale scrollback.
  const res = await execCmd('tmux', ['capture-pane', '-p', '-t', paneId]);
  if (!res.ok) return '';
  // Only keep the last 20 non-empty lines to avoid stale content
  const lines = res.stdout.split('\n');
  // Trim trailing empty lines then take last 20
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-20).join('\n');
}

// Strip ANSI escape codes
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[^[]/g, '');
}

// ── Status detection ──────────────────────────────────────────────────────

function isWaitPrompt(line) {
  if (!line) return false;
  const clean = stripAnsi(line).trim();
  return WAIT_PROMPTS.some(rx => rx.test(clean));
}

function hasRunIndicator(recentLines) {
  const text = recentLines.join('\n');
  return RUN_SYMBOLS.some(rx => rx.test(text)) || RUN_TEXT.some(rx => rx.test(text));
}

function statusForPane(pane, output, now) {
  const command = pane.command.toLowerCase();

  if (IGNORE_COMMANDS.has(command)) return null;
  if (IDLE_SHELLS.has(command)) return { status: 'idle', waitingSince: null };

  const allLines = output.split('\n');
  const lastLine = allLines[allLines.length - 1] || '';
  const recentLines = allLines.slice(-4);

  const prev = paneMemory.get(pane.paneId);
  const changed = !prev || prev.output !== output;
  const stableFor = prev && !changed ? now - prev.lastChangedAt : 0;
  const isAgent = AGENT_COMMANDS.has(command);

  // Priority 1: explicit wait prompt on last line → immediate waiting
  const explicitWait = isWaitPrompt(lastLine);

  // Priority 2: active running indicators in recent lines
  const activelyRunning = hasRunIndicator(recentLines);

  let status;
  let waitingSince = prev?.waitingSince || null;

  if (isAgent && explicitWait && !activelyRunning) {
    // Clear wait prompt visible, no spinners → waiting immediately
    status = 'waiting';
    waitingSince = waitingSince || now;
  } else if (activelyRunning || changed) {
    // Spinners visible or output just changed → running
    status = 'running';
    waitingSince = null;
  } else if (isAgent && stableFor >= WAIT_STABLE_MS) {
    // Output hasn't changed for a while → probably waiting (fallback)
    status = 'waiting';
    waitingSince = waitingSince || now - stableFor;
  } else {
    status = 'running';
    waitingSince = null;
  }

  paneMemory.set(pane.paneId, {
    output,
    lastChangedAt: changed ? now : (prev?.lastChangedAt || now),
    waitingSince: status === 'waiting' ? waitingSince : null
  });

  return { status, waitingSince: status === 'waiting' ? waitingSince : null };
}

// ── WezTerm tab mapping ───────────────────────────────────────────────────

let _weztermLogged = false;

async function weztermMap(sessions) {
  const res = await execCmd('wezterm', ['cli', 'list', '--format', 'json']);
  if (!res.ok) return {};

  try {
    const items = JSON.parse(res.stdout || '[]');

    if (items.length > 0 && !_weztermLogged) {
      _weztermLogged = true;
      console.log('[helm] wezterm fields:', Object.keys(items[0]).join(', '));
    }

    const map = {};
    for (const sessionName of sessions) {
      const match = items.find((item) => {
        const blob = JSON.stringify(item).toLowerCase();
        return blob.includes(sessionName.toLowerCase());
      });
      if (match) {
        const tabId = match.tab_id ?? match.tabId ?? match.tab?.id ?? null;
        if (tabId != null) map[sessionName] = tabId;
      }
    }
    return map;
  } catch (e) {
    console.error('[helm] weztermMap parse error:', e.message);
    return {};
  }
}

// ── AI naming ─────────────────────────────────────────────────────────────

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try { return fs.readFileSync(ANTHROPIC_KEY_FILE, 'utf8').trim(); } catch { return null; }
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
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 20, messages: [{ role: 'user', content: prompt }] })
    });
    if (!response.ok) return sessionName;
    const data = await response.json();
    return cleanTaskName(data?.content?.[0]?.text, sessionName);
  } catch { return sessionName; }
}

// ── Build state ───────────────────────────────────────────────────────────

async function buildState() {
  const panes = await listTmuxPanes();
  if (!panes) return { fronts: [], summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };

  const now = Date.now();
  const names = readNames();
  const confirmed = readConfirmed();
  const sessions = [...new Set(panes.map(p => p.sessionName))];
  const tabMap = await weztermMap(sessions);

  // Trigger AI naming for new sessions (fire-and-forget)
  for (const s of sessions) {
    if (!names[s] && !aiSuggestedSessions.has(s)) {
      aiSuggestedSessions.add(s);
      const sample = panes.find(p => p.sessionName === s);
      suggestName(s, sample?.panePath, sample?.command).then((suggested) => {
        const cur = readNames();
        if (!cur[s]) { cur[s] = suggested; writeNames(cur); }
      });
    }
  }

  const frontsMap = new Map();
  for (const pane of panes) {
    const output = await capturePane(pane.paneId);
    const st = statusForPane(pane, output, now);
    if (!st) continue;

    if (!frontsMap.has(pane.sessionName)) {
      frontsMap.set(pane.sessionName, {
        name: names[pane.sessionName] || pane.sessionName,
        sessionName: pane.sessionName,
        weztermTabId: tabMap[pane.sessionName] || null,
        aiSuggested: !!(names[pane.sessionName] && names[pane.sessionName] !== pane.sessionName && !confirmed[pane.sessionName]),
        agents: []
      });
    }

    const lines = output.split('\n').filter(Boolean);
    const lastOutput = (lines[lines.length - 1] || '').trim().slice(0, 140);
    // Task: try to find a meaningful line (first non-empty, non-prompt line)
    const taskLine = lines.find(l => l.trim().length > 10 && !/^[>❯$]\s*$/.test(l.trim())) || '';

    frontsMap.get(pane.sessionName).agents.push({
      paneId: pane.paneId,
      windowName: pane.windowName,
      command: pane.command,
      task: taskLine.trim().slice(0, 80),
      status: st.status,
      lastOutput,
      waitingSince: st.waitingSince
    });
  }

  const fronts = [...frontsMap.values()].map(f => ({
    ...f,
    agents: f.agents.sort((a, b) => {
      const rank = { waiting: 0, running: 1, idle: 2 };
      return (rank[a.status] ?? 2) - (rank[b.status] ?? 2);
    })
  }));

  const waitingAgents = fronts.flatMap(f => f.agents.map(a => ({ ...a, frontName: f.name }))).filter(a => a.status === 'waiting');
  waitingAgents.sort((a, b) => (a.waitingSince || Infinity) - (b.waitingSince || Infinity));

  return {
    fronts,
    summary: {
      total: fronts.length,
      totalAgents: fronts.reduce((n, f) => n + f.agents.length, 0),
      waiting: waitingAgents.length,
      oldestWaiting: waitingAgents[0] ? { frontName: waitingAgents[0].frontName, paneId: waitingAgents[0].paneId, waitingSince: waitingAgents[0].waitingSince } : null
    }
  };
}

// ── WebSocket server ──────────────────────────────────────────────────────

const wss = new WebSocket.Server({ port: PORT });
wss.on('connection', (ws) => ws.send(cachedStateJson));

function broadcast(json) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
}

async function tick() {
  try {
    const next = await buildState();
    const json = JSON.stringify(next);
    if (json !== cachedStateJson) {
      cachedState = next;
      cachedStateJson = json;
      broadcast(json);
    }
  } catch (e) {
    console.error('[helm] tick error:', e.message);
  }
}

ensureFiles();
setInterval(tick, POLL_MS);
tick();

console.log(`Helm daemon running on ws://localhost:${PORT}`);

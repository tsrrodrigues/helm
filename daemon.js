const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 7373;
const POLL_MS = 2000;
const WAIT_WITH_PROMPT_MS = 3000;   // stable + recognized prompt → waiting
const WAIT_NO_PROMPT_MS = 8000;     // stable + no prompt → waiting (fallback)

const HOME = os.homedir();
const HELM_DIR = path.join(HOME, '.helm');
const NAMES_FILE = path.join(HELM_DIR, 'session-names.json');
const CONFIRMED_FILE = path.join(HELM_DIR, 'confirmed-names.json');
const ANTHROPIC_KEY_FILE = path.join(HOME, '.config', 'anthropic', 'api_key');

const IGNORE_COMMANDS = new Set(['vim', 'nvim', 'less', 'man']);
const IDLE_SHELLS = new Set(['bash', 'zsh', 'fish']);

// Agent detection: command name can be a version string (e.g. "2.1.37"),
// the binary name (e.g. "codex-aarch64-a"), or the expected name.
// We use patterns instead of exact match.
const AGENT_PATTERNS = [/claude/i, /codex/i, /^node$/i, /^\d+\.\d+\.\d+$/];

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
const prevPaneStatus = new Map();   // paneId → 'running' | 'waiting' | 'idle'
const interactionStart = new Map(); // paneId → timestamp (start of current interaction)
const lastRenameAt = new Map();     // sessionName → timestamp
const RENAME_COOLDOWN_MS = 30000;
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
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':'),
  LANG: process.env.LANG || 'en_US.UTF-8'
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

// ── Process tree detection ────────────────────────────────────────────────

// Patterns for persistent/background children to ignore (not tool executions)
const PERSISTENT_CHILD_PATTERNS = [
  /--stdio/i,            // MCP / language servers
  /\bmcp\b/i,            // MCP servers
  /^caffeinate\b/,       // macOS sleep-prevention utility
];

function isPersistentChild(args) {
  return PERSISTENT_CHILD_PATTERNS.some(rx => rx.test(args));
}

async function getProcessTree() {
  const res = await execCmd('ps', ['-eo', 'pid=,ppid=,args='], 5000);
  if (!res.ok) return new Map();
  const tree = new Map(); // ppid → [{pid, args}]
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = match[1];
    const ppid = match[2];
    const args = match[3].trim();
    if (!tree.has(ppid)) tree.set(ppid, []);
    tree.get(ppid).push({ pid, args });
  }
  return tree;
}

function getAgentInfo(panePids, processTree) {
  const result = new Map(); // paneId → {agentPid, hasActiveChildren}
  for (const [paneId, panePid] of panePids) {
    const children = processTree.get(panePid) || [];
    // Find the agent binary (direct child of the pane shell)
    const agentChild = children.find(c => {
      const basename = path.basename(c.args.split(/\s/)[0]).toLowerCase();
      return AGENT_PATTERNS.some(rx => rx.test(basename));
    });
    if (!agentChild) continue;

    // Check if agent has non-persistent children (tool executions)
    const agentChildren = processTree.get(agentChild.pid) || [];
    const hasActiveChildren = agentChildren.some(c => !isPersistentChild(c.args));
    result.set(paneId, { agentPid: agentChild.pid, hasActiveChildren });
  }
  return result;
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

function statusForPane(pane, output, now, hasActiveChildren) {
  const command = pane.command.toLowerCase();

  if (IGNORE_COMMANDS.has(command)) return null;
  if (IDLE_SHELLS.has(command)) return { status: 'idle', waitingSince: null };

  // Process tree override: if agent has active (non-persistent) children,
  // it's definitely running a tool — terminal heuristics don't matter
  if (hasActiveChildren === true) {
    paneMemory.set(pane.paneId, {
      output,
      lastChangedAt: Date.now(),
      waitingSince: null
    });
    return { status: 'running', waitingSince: null };
  }

  const allLines = output.split('\n');
  const lastLine = allLines[allLines.length - 1] || '';
  const recentLines = allLines.slice(-4);

  const prev = paneMemory.get(pane.paneId);
  const changed = !prev || prev.output !== output;
  const stableFor = prev && !changed ? now - prev.lastChangedAt : 0;
  const isAgent = AGENT_PATTERNS.some(rx => rx.test(command));

  const explicitWait = isWaitPrompt(lastLine);
  const activelyRunning = hasRunIndicator(recentLines);

  let status;
  let waitingSince = prev?.waitingSince || null;

  if (activelyRunning || changed) {
    // Spinners visible OR output just changed → always running
    // No prompt can override this — output activity is the strongest signal
    status = 'running';
    waitingSince = null;
  } else if (isAgent && !changed && explicitWait && stableFor >= WAIT_WITH_PROMPT_MS) {
    // Output stable for 3s + recognized wait prompt → waiting
    status = 'waiting';
    waitingSince = waitingSince || now - stableFor;
  } else if (isAgent && !changed && stableFor >= WAIT_NO_PROMPT_MS) {
    // Output stable for 8s without any recognized prompt → probably waiting (fallback)
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

async function weztermMap(sessions) {
  const [wzRes, tmuxRes] = await Promise.all([
    execCmd('wezterm', ['cli', 'list', '--format', 'json']),
    execCmd('tmux', ['list-clients', '-F', '#{client_tty}\t#{session_name}'])
  ]);
  if (!wzRes.ok) return {};

  try {
    const items = JSON.parse(wzRes.stdout || '[]');

    // Build TTY → WezTerm tab_id map
    const ttyToTab = {};
    for (const item of items) {
      if (item.tty_name) ttyToTab[item.tty_name] = item.tab_id ?? item.tabId ?? null;
    }

    // Build session → TTY map from tmux clients
    const sessionToTty = {};
    if (tmuxRes.ok) {
      for (const line of tmuxRes.stdout.split('\n').filter(Boolean)) {
        const [tty, session] = line.split('\t');
        if (tty && session) sessionToTty[session] = tty;
      }
    }

    // Cross-reference: session → TTY → tab_id
    const map = {};
    for (const sessionName of sessions) {
      const tty = sessionToTty[sessionName];
      if (tty && ttyToTab[tty] != null) {
        map[sessionName] = ttyToTab[tty];
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

async function suggestNameFromOutput(sessionName, output, status) {
  const key = getApiKey();
  if (!key) return sessionName;

  const lines = output.split('\n').filter(Boolean).slice(-20);
  const recentOutput = lines.join('\n').slice(-1500);

  const prompt = `You name terminal sessions. Based on the output below from an AI coding agent, suggest a short name (2-4 words, title case) that describes the current task.\n\nStatus: ${status}\nRecent output:\n${recentOutput}\n\nReply with ONLY the name, nothing else.`;

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

  // Build process tree once per tick
  const processTree = await getProcessTree();
  const panePids = new Map(); // paneId → panePid
  for (const pane of panes) if (pane.panePid) panePids.set(pane.paneId, pane.panePid);
  const agentInfo = getAgentInfo(panePids, processTree);

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
    const info = agentInfo.get(pane.paneId);
    const hasActiveChildren = info ? info.hasActiveChildren : undefined;
    const st = statusForPane(pane, output, now, hasActiveChildren);
    if (!st) continue;

    // Track interaction start: reset when transitioning from waiting/idle → running
    const prevStatus = prevPaneStatus.get(pane.paneId);
    if (st.status === 'running' && (!prevStatus || prevStatus !== 'running')) {
      interactionStart.set(pane.paneId, now);
    } else if (st.status === 'idle') {
      interactionStart.delete(pane.paneId);
    }
    prevPaneStatus.set(pane.paneId, st.status);
    if (prevStatus && prevStatus !== st.status && !confirmed[pane.sessionName]) {
      const lastRename = lastRenameAt.get(pane.sessionName) || 0;
      if (now - lastRename >= RENAME_COOLDOWN_MS) {
        lastRenameAt.set(pane.sessionName, now);
        console.log(`[helm] status change ${pane.sessionName}: ${prevStatus} → ${st.status}, renaming...`);
        suggestNameFromOutput(pane.sessionName, output, st.status).then((suggested) => {
          const cur = readNames();
          const conf = readConfirmed();
          if (!conf[pane.sessionName]) {
            cur[pane.sessionName] = suggested;
            writeNames(cur);
          }
        });
      }
    }

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
      waitingSince: st.waitingSince,
      interactionStartedAt: interactionStart.get(pane.paneId) || null
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

// Debug HTTP server — GET /debug shows raw pane captures + detection results
const http = require('http');
http.createServer(async (req, res) => {
  if (req.url !== '/debug') { res.writeHead(404); res.end(); return; }
  const panes = await listTmuxPanes();
  if (!panes) { res.writeHead(200); res.end('no tmux panes\n'); return; }
  const lines = [];
  for (const p of panes) {
    const output = await capturePane(p.paneId);
    const allLines = output.split('\n');
    const lastLine = allLines[allLines.length - 1] || '';
    const cleanLast = stripAnsi(lastLine).trim();
    const wait = isWaitPrompt(lastLine);
    const runInd = hasRunIndicator(allLines.slice(-4));
    lines.push(`\n=== ${p.sessionName}:${p.windowName} pane=${p.paneId} cmd=${p.command} ===`);
    lines.push(`lastLine (raw): ${JSON.stringify(lastLine)}`);
    lines.push(`lastLine (clean): ${JSON.stringify(cleanLast)}`);
    lines.push(`isWaitPrompt: ${wait}`);
    lines.push(`hasRunIndicator: ${runInd}`);
    lines.push(`isAgent: ${AGENT_PATTERNS.some(rx => rx.test(p.command.toLowerCase()))}`);
    lines.push(`isIgnored: ${IGNORE_COMMANDS.has(p.command.toLowerCase())}`);
    lines.push(`--- last 5 lines ---`);
    allLines.slice(-5).forEach((l, i) => lines.push(`  ${i}: ${JSON.stringify(l)}`));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(lines.join('\n') + '\n');
}).listen(7374, '127.0.0.1');
console.log('Debug endpoint: http://127.0.0.1:7374/debug');

ensureFiles();
setInterval(tick, POLL_MS);
tick();

console.log(`Helm daemon running on ws://localhost:${PORT}`);

const { execFile, spawn } = require('child_process');
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
const PANE_TASKS_FILE = path.join(HELM_DIR, 'pane-tasks.json');

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
const paneTaskNames = new Map();    // paneId → AI-generated short task name
const paneTaskInitialized = new Set(); // panes that already got an initial name
const paneWaitSummaries = new Map();   // paneId → AI-generated context summary when waiting
let cachedState = { fronts: [], activePane: null, summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };
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

const PANE_TASKS_VERSION = 2; // bump to force regeneration of all task names
const PANE_TASKS_VERSION_FILE = path.join(HELM_DIR, 'pane-tasks-version.json');

function loadPaneTasks() {
  const versionData = readJson(PANE_TASKS_VERSION_FILE);
  if (versionData.version === PANE_TASKS_VERSION) {
    const data = readJson(PANE_TASKS_FILE);
    for (const [k, v] of Object.entries(data)) paneTaskNames.set(k, v);
  } else {
    // Version mismatch: clear old names so they regenerate with current prompt
    console.log('[helm] pane-tasks version changed, regenerating all task names');
    writeJson(PANE_TASKS_FILE, {});
    writeJson(PANE_TASKS_VERSION_FILE, { version: PANE_TASKS_VERSION });
  }
}

function savePaneTasks() {
  const obj = {};
  for (const [k, v] of paneTaskNames) obj[k] = v;
  writeJson(PANE_TASKS_FILE, obj);
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
  const fmt = '#{session_name}\t#{window_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{pane_title}\t#{pane_current_path}\t#{session_attached}\t#{window_active}\t#{pane_active}';
  const res = await execCmd('tmux', ['list-panes', '-a', '-F', fmt]);
  if (!res.ok) return null;

  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sessionName, windowName, paneId, command, panePid, paneTitle, panePath, sessionAttached, windowActive, paneActive] = line.split('\t');
      return { sessionName, windowName, paneId, command: (command || '').trim(), panePid, paneTitle: paneTitle || '', panePath: panePath || '', isActive: sessionAttached === '1' && windowActive === '1' && paneActive === '1' };
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

// ── AI naming (via Claude Code CLI) ──────────────────────────────────────

const CLAUDE_BIN = '/Users/tiagorodrigues/.local/bin/claude';

function cleanTaskName(raw, fallback) {
  const text = String(raw || '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return fallback;
  return text.replace(/^['"`]|['"`]$/g, '').slice(0, 40).toLowerCase();
}

function askClaude(prompt) {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, ['-p', '--model', 'haiku', '--no-session-persistence'], {
      env: sysEnv, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0) { console.error('[helm] askClaude error:', stderr.trim()); resolve(null); return; }
      const result = stdout.trim();
      console.log('[helm] askClaude result:', result);
      resolve(result || null);
    });
    proc.on('error', (e) => { console.error('[helm] askClaude spawn error:', e.message); resolve(null); });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

async function suggestName(sessionName, panePath, command) {
  const prompt = `Suggest a short task name (2-4 words, title case) for a terminal session.\nDirectory: ${panePath || '(unknown)'}\nCommand: ${command || '(unknown)'}\nSession: ${sessionName}\nReply with ONLY the task name, nothing else.`;
  const raw = await askClaude(prompt);
  return cleanTaskName(raw, sessionName);
}

async function suggestPaneTask(paneId, output, panePath) {
  const lines = output.split('\n').filter(Boolean).slice(-20);
  const recentOutput = lines.join('\n').slice(-1500);
  const projectDir = panePath ? path.basename(panePath) : '(unknown)';
  const prompt = `Give a 2-4 word fixed title for this terminal tab. The title identifies the SCOPE or AREA of work, not the current action. It should remain valid even as the agent moves between tasks.

Rules:
- Identify the module, feature, or subsystem: "auth middleware", "socket ipc", "overlay css", "daemon polling"
- Do NOT describe actions (no "fixing", "adding", "refactoring", "implementing")
- Do NOT repeat the project name "${projectDir}" — it's already shown separately
- Lowercase, no quotes
- Be specific: prefer "pane status detection" over "daemon"

Project: ${projectDir}
Terminal output (last 20 lines):
${recentOutput}

Reply with ONLY the title.`;
  const raw = await askClaude(prompt);
  return raw ? cleanTaskName(raw, null) : null;
}

async function generateWaitSummary(paneId, output, panePath) {
  const lines = output.split('\n').filter(Boolean).slice(-20);
  const recentOutput = lines.join('\n').slice(-1500);
  const projectDir = panePath ? path.basename(panePath) : '(unknown)';
  const prompt = `List what this AI agent did and why it stopped, as bullet keywords (no full sentences). Max 3 bullets, each 3-6 words. Use file names, function names, error names. Portuguese (BR).

Format example:
• editou daemon.js:376 prompt
• criou generateWaitSummary()
• aguarda: escolha de abordagem

Project: ${projectDir}
Terminal output (last 20 lines):
${recentOutput}

Reply with ONLY the bullets.`;
  const raw = await askClaude(prompt);
  if (raw) {
    const summary = raw.trim().slice(0, 200);
    paneWaitSummaries.set(paneId, summary);
  }
}

// ── Build state ───────────────────────────────────────────────────────────

async function buildState() {
  const panes = await listTmuxPanes();
  if (!panes) return { fronts: [], activePane: null, summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };

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
    if (prevStatus && prevStatus !== st.status) {
      // Generate context summary when transitioning to waiting (fire-and-forget)
      if (st.status === 'waiting') {
        generateWaitSummary(pane.paneId, output, pane.panePath);
      }
    }

    // Generate initial task name for panes that don't have one yet
    if (!paneTaskNames.has(pane.paneId) && !paneTaskInitialized.has(pane.paneId) && st.status !== 'idle') {
      paneTaskInitialized.add(pane.paneId);
      suggestPaneTask(pane.paneId, output, pane.panePath).then((name) => {
        if (name) { paneTaskNames.set(pane.paneId, name); savePaneTasks(); }
      });
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

    frontsMap.get(pane.sessionName).agents.push({
      paneId: pane.paneId,
      windowName: pane.windowName,
      command: pane.command,
      task: paneTaskNames.get(pane.paneId) || pane.windowName,
      status: st.status,
      lastOutput,
      waitingSince: st.waitingSince,
      waitingSummary: st.status === 'waiting' ? (paneWaitSummaries.get(pane.paneId) || null) : null,
      interactionStartedAt: interactionStart.get(pane.paneId) || null,
      panePath: pane.panePath
    });
  }

  const fronts = [...frontsMap.values()].map(f => {
    // Derive projectDir from the most frequent panePath basename
    const pathCounts = {};
    for (const a of f.agents) {
      if (a.panePath) {
        const dir = path.basename(a.panePath);
        pathCounts[dir] = (pathCounts[dir] || 0) + 1;
      }
    }
    let projectDir = '';
    let maxCount = 0;
    for (const [dir, count] of Object.entries(pathCounts)) {
      if (count > maxCount) { maxCount = count; projectDir = dir; }
    }
    return {
      ...f,
      projectDir
    };
  });

  const waitingAgents = fronts.flatMap(f => f.agents.map(a => ({ ...a, frontName: f.name }))).filter(a => a.status === 'waiting');
  waitingAgents.sort((a, b) => (a.waitingSince || Infinity) - (b.waitingSince || Infinity));

  // Find the currently active pane (attached session, active window, active pane)
  const activePaneObj = panes.find(p => p.isActive);

  return {
    fronts,
    activePane: activePaneObj ? activePaneObj.paneId : null,
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
loadPaneTasks();
setInterval(tick, POLL_MS);
tick();

console.log(`Helm daemon running on ws://localhost:${PORT}`);

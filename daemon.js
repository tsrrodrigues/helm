const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 7373;
const POLL_MS = 5000;
const WAIT_WITH_PROMPT_MS = 3000;   // stable + recognized prompt → waiting
const WAIT_NO_PROMPT_MS = 8000;     // stable + no prompt → waiting (fallback)

const HOME = os.homedir();
const HELM_DIR = path.join(HOME, '.helm');
const NAMES_FILE = path.join(HELM_DIR, 'session-names.json');
const CONFIRMED_FILE = path.join(HELM_DIR, 'confirmed-names.json');
const PANE_TASKS_FILE = path.join(HELM_DIR, 'pane-tasks.json');
const PANE_CLAUDE_SESSIONS_FILE = path.join(HELM_DIR, 'pane-claude-sessions.json');

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
const hookWaitingOverride = new Map(); // paneId → { timestamp, cwd, sessionId }
const paneResponseCards = new Map();   // paneId → { type, hero, options, keywords, kpis, command }
const paneClaudeSessionIds = new Map(); // paneId → Claude Code session UUID (persisted)
const HOOK_TTL_MS = 30000; // 30s TTL for hook overrides
let cachedState = { fronts: [], activePane: null, activeSessionName: null, summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };
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

const PANE_TASKS_VERSION = 4; // bump to force regeneration of all task names
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

function loadPaneClaudeSessions() {
  const data = readJson(PANE_CLAUDE_SESSIONS_FILE);
  for (const [k, v] of Object.entries(data)) paneClaudeSessionIds.set(k, v);
}

function savePaneClaudeSessions() {
  const obj = {};
  for (const [k, v] of paneClaudeSessionIds) obj[k] = v;
  writeJson(PANE_CLAUDE_SESSIONS_FILE, obj);
}

// Fallback: resolve Claude Code session ID from filesystem when hook hasn't provided it
function resolveClaudeSessionFromFs(panePath) {
  if (!panePath) return null;
  const encoded = panePath.replace(/\//g, '-');
  const dir = path.join(HOME, '.claude', 'projects', encoded);
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl') && /^[0-9a-f]{8}-/.test(f))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length) return files[0].name.replace('.jsonl', '');
  } catch {}
  return null;
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

const WEZTERM_SOCK_DIR = path.join(os.homedir(), '.local', 'share', 'wezterm');

function findWeztermSocket() {
  try {
    const entries = fs.readdirSync(WEZTERM_SOCK_DIR);
    for (const e of entries) {
      if (!e.startsWith('gui-sock-')) continue;
      const pid = parseInt(e.replace('gui-sock-', ''), 10);
      if (!pid) continue;
      try { process.kill(pid, 0); return path.join(WEZTERM_SOCK_DIR, e); } catch {}
    }
  } catch {}
  return null;
}

function execCmd(cmd, args = [], timeout = 3500) {
  const bin = cmd === 'wezterm' ? weztermBin : cmd;
  const env = cmd === 'wezterm' ? (() => { const sock = findWeztermSocket(); return sock ? { ...sysEnv, WEZTERM_UNIX_SOCKET: sock } : sysEnv; })() : sysEnv;
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env }, (error, stdout, stderr) => {
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
      return { sessionName, windowName, paneId, command: (command || '').trim(), panePid, paneTitle: paneTitle || '', panePath: panePath || '', isActive: sessionAttached === '1' && windowActive === '1' && paneActive === '1', isWindowActive: windowActive === '1' && paneActive === '1' };
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

async function capturePaneStart(paneId) {
  // Capture from the very start of the scrollback history
  const res = await execCmd('tmux', ['capture-pane', '-p', '-S', '-', '-t', paneId]);
  if (!res.ok) return '';
  const lines = res.stdout.split('\n');
  // Take first 150 lines — enough to find the initial user prompt in Claude Code / Codex
  return lines.slice(0, 150).join('\n');
}

function extractFirstPrompt(scrollbackText) {
  const lines = scrollbackText.split('\n');
  // Look for the first user prompt marker: ❯ (Claude Code) or lines after `claude "..."`
  let promptLines = [];
  let collecting = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Claude Code interactive prompt: line starts with ❯
    if (!collecting && /^❯\s/.test(trimmed)) {
      promptLines.push(trimmed.replace(/^❯\s*/, ''));
      collecting = true;
      continue;
    }

    // Inline invocation: `claude "..."` or `claude '...'`
    if (!collecting) {
      const inlineMatch = trimmed.match(/\bclaude\s+["'](.+?)["']/);
      if (inlineMatch) {
        promptLines.push(inlineMatch[1]);
        break;
      }
      // Codex inline: `codex "..."`
      const codexMatch = trimmed.match(/\bcodex\s+["'](.+?)["']/);
      if (codexMatch) {
        promptLines.push(codexMatch[1]);
        break;
      }
    }

    // If collecting multi-line prompt: continuation lines are indented or plain text
    // Stop at agent response markers (⏺, tool output, empty line after content)
    if (collecting) {
      if (/^⏺/.test(trimmed) || /^\s*$/.test(trimmed) || /^╭/.test(trimmed) || /^>/.test(trimmed)) {
        break;
      }
      promptLines.push(trimmed);
    }
  }

  return promptLines.join(' ').trim().slice(0, 500) || null;
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
    hookWaitingOverride.delete(pane.paneId); // agent resumed, clear hook override
    paneMemory.set(pane.paneId, {
      output,
      lastChangedAt: Date.now(),
      waitingSince: null
    });
    return { status: 'running', waitingSince: null };
  }

  // Hook override: Claude Code Stop hook signaled this pane is waiting
  const hookOverride = hookWaitingOverride.get(pane.paneId);
  if (hookOverride) {
    const hookAge = now - hookOverride.timestamp;
    const prev = paneMemory.get(pane.paneId);
    const changed = !prev || prev.output !== output;
    const activelyRunning = hasRunIndicator(output.split('\n').slice(-4));
    if (hookAge > HOOK_TTL_MS || (changed && activelyRunning)) {
      // Expired or agent clearly resumed — clear override
      hookWaitingOverride.delete(pane.paneId);
    } else {
      // Trust the hook: mark as waiting immediately
      paneMemory.set(pane.paneId, {
        output,
        lastChangedAt: prev?.lastChangedAt || now,
        waitingSince: hookOverride.timestamp
      });
      return { status: 'waiting', waitingSince: hookOverride.timestamp };
    }
  }

  const allLines = output.split('\n');
  // Find the actual last content line, skipping Claude Code status bar (⏵) and separator lines (───)
  let lastLine = '';
  for (let i = allLines.length - 1; i >= 0; i--) {
    const clean = stripAnsi(allLines[i]).trim();
    if (clean && !clean.startsWith('⏵') && !clean.startsWith('───')) {
      lastLine = allLines[i];
      break;
    }
  }
  const recentLines = allLines.slice(-4);

  const prev = paneMemory.get(pane.paneId);
  const changed = !prev || prev.output !== output;
  const stableFor = prev && !changed ? now - prev.lastChangedAt : 0;
  const isAgent = AGENT_PATTERNS.some(rx => rx.test(command));

  const explicitWait = isWaitPrompt(lastLine);
  const activelyRunning = hasRunIndicator(recentLines);

  let status;
  let waitingSince = prev?.waitingSince || null;

  if (activelyRunning || (changed && !explicitWait)) {
    // Spinners visible OR output changed without a wait prompt → running
    status = 'running';
    waitingSince = null;
  } else if (isAgent && explicitWait && (stableFor >= WAIT_WITH_PROMPT_MS || prev?.waitingSince)) {
    // Recognized wait prompt + stable for 3s → waiting
    // OR: already waiting + cosmetic change (e.g. status bar file count) → stay waiting
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

  // Cosmetic change = output changed but wait prompt present and no run indicators.
  // Don't reset stability timer for cosmetic changes (e.g. status bar file count update).
  const cosmeticChange = changed && explicitWait && !activelyRunning;
  paneMemory.set(pane.paneId, {
    output,
    lastChangedAt: (changed && !cosmeticChange) ? now : (prev?.lastChangedAt || now),
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
  if (!wzRes.ok) return { tabMap: {}, activeSession: null };

  try {
    const items = JSON.parse(wzRes.stdout || '[]');

    // Build TTY → WezTerm tab info map
    const ttyToTab = {};
    for (const item of items) {
      if (item.tty_name) ttyToTab[item.tty_name] = { tabId: item.tab_id ?? item.tabId ?? null, isActive: !!item.is_active };
    }

    // Build session → TTY map from tmux clients
    const sessionToTty = {};
    if (tmuxRes.ok) {
      for (const line of tmuxRes.stdout.split('\n').filter(Boolean)) {
        const [tty, session] = line.split('\t');
        if (tty && session) sessionToTty[session] = tty;
      }
    }

    // Cross-reference: session → TTY → tab_id, and find WezTerm-active session
    const tabMap = {};
    let activeSession = null;
    for (const sessionName of sessions) {
      const tty = sessionToTty[sessionName];
      if (tty && ttyToTab[tty]) {
        tabMap[sessionName] = ttyToTab[tty].tabId;
        if (ttyToTab[tty].isActive) activeSession = sessionName;
      }
    }
    return { tabMap, activeSession };
  } catch (e) {
    console.error('[helm] weztermMap parse error:', e.message);
    return { tabMap: {}, activeSession: null };
  }
}

// ── AI naming (via Claude Code CLI) ──────────────────────────────────────

const CLAUDE_BIN = '/Users/tiagorodrigues/.local/bin/claude';

function cleanTaskName(raw, fallback) {
  const text = String(raw || '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return fallback;
  let name = text.replace(/^['"`]|['"`]$/g, '').toLowerCase();
  // Reject dissertations: too many words means the model didn't follow format
  const words = name.split(/\s+/);
  if (words.length > 5) return fallback;
  // Reject responses that start with conversational/explanatory patterns
  if (/^(i |i'm |the |this |that |it |looking |based |here |there |from |seems? )/.test(name)) return fallback;
  return name.slice(0, 40);
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
  // Capture the beginning of the session to find the user's first prompt
  const startOutput = await capturePaneStart(paneId);
  const userPrompt = extractFirstPrompt(startOutput);
  const projectDir = panePath ? path.basename(panePath) : '(unknown)';

  if (userPrompt) {
    // We have the user's actual first prompt — generate name directly from it
    const prompt = `Generate a 2-4 word task name from this user instruction to an AI coding agent.

User's instruction: "${userPrompt}"

Rules:
- Extract KEY WORDS directly from the instruction — the name must contain words the user actually wrote
- Keep the SAME LANGUAGE as the instruction (if Portuguese, name in Portuguese; if English, name in English)
- Do NOT translate, do NOT rephrase into English
- Do NOT repeat the project name "${projectDir}"
- lowercase, no quotes
- 2-4 words only

Reply with ONLY the task name.`;
    const raw = await askClaude(prompt);
    return raw ? cleanTaskName(raw, null) : null;
  }

  // Fallback: no prompt extracted, use the scrollback start
  const prompt = `You are reading the beginning of an AI coding agent session (Claude Code, Codex, or similar).
Find the FIRST instruction the user gave and generate a 2-4 word task name from it.

Rules:
- Extract KEY WORDS directly from the user's prompt — the name must contain words the user actually wrote
- Keep the SAME LANGUAGE as the user's instruction (if Portuguese, name in Portuguese; if English, name in English)
- Do NOT translate, do NOT rephrase into English
- Do NOT use generic terms (no "code review", "terminal session")
- Do NOT repeat the project name "${projectDir}"
- lowercase, no quotes

Session start:
${startOutput.slice(0, 4000)}

Reply with ONLY the task name.`;
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

// ── Response card parsing ─────────────────────────────────────────────────

function parseResponseCard(terminalSnapshot, lastAssistantMessage) {
  const text = lastAssistantMessage || terminalSnapshot || '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Detect numbered options (1. Foo, 2. Bar, etc.)
  const optionLines = lines.filter(l => /^\d+[\.\)]\s+/.test(l));
  if (optionLines.length >= 2) {
    const options = optionLines.map(l => {
      const label = l.replace(/^\d+[\.\)]\s+/, '').trim();
      // Extract keywords from option text
      const tags = extractCardKeywords(label);
      return { label, tags };
    });
    // The question is usually the line before the options
    const firstOptIdx = lines.indexOf(optionLines[0].trim());
    const questionLines = lines.slice(Math.max(0, firstOptIdx - 3), firstOptIdx);
    const hero = questionLines.join(' ').trim() || 'Escolha uma opção';
    const keywords = extractCardKeywords(text);
    return { type: 'question', hero, options, keywords, kpis: [] };
  }

  // Detect permission prompts
  if (/\(y\/n\)/i.test(text) || /allow|permit|approve|deny/i.test(text)) {
    const cmdMatch = text.match(/(?:run|execute|command):\s*(.+)/i) || text.match(/`([^`]+)`/);
    const command = cmdMatch ? cmdMatch[1].trim() : '';
    const hero = lines.find(l => /\?/.test(l)) || 'Permissão necessária';
    const keywords = extractCardKeywords(text);
    return { type: 'permission', hero, command, keywords, kpis: [] };
  }

  // Default: response/summary card
  const hero = lastAssistantMessage
    ? lastAssistantMessage.split('\n')[0].slice(0, 200)
    : (lines[lines.length - 1] || '').slice(0, 200);
  const keywords = extractCardKeywords(text);
  const kpis = extractKpis(text);
  return { type: 'response', hero, keywords, kpis };
}

function extractCardKeywords(text) {
  const keywords = [];
  // File paths and names
  const files = text.match(/[\w\-]+\.\w{1,6}/g) || [];
  files.forEach(f => { if (!keywords.includes(f)) keywords.push(f); });
  // Function names
  const funcs = text.match(/\b\w+\(\)/g) || [];
  funcs.forEach(f => { if (!keywords.includes(f)) keywords.push(f); });
  // Technical terms (camelCase, PascalCase)
  const terms = text.match(/\b[a-z]+[A-Z]\w+/g) || [];
  terms.forEach(t => { if (!keywords.includes(t)) keywords.push(t); });
  return keywords.slice(0, 8);
}

function extractKpis(text) {
  const kpis = [];
  const filesMatch = text.match(/(\d+)\s*(?:files?|arquivos?)/i);
  if (filesMatch) kpis.push({ num: filesMatch[1], label: 'arquivos', color: 'blue' });
  const linesMatch = text.match(/[+]?(\d+)\s*(?:lines?|linhas?)/i);
  if (linesMatch) kpis.push({ num: '+' + linesMatch[1], label: 'linhas', color: 'green' });
  const testsMatch = text.match(/(\d+)\s*(?:tests?|testes?)/i);
  if (testsMatch) kpis.push({ num: testsMatch[1], label: 'testes', color: 'green' });
  return kpis;
}

// ── Build state ───────────────────────────────────────────────────────────

async function buildState() {
  const panes = await listTmuxPanes();
  if (!panes) return { fronts: [], activePane: null, activeSessionName: null, summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };

  const now = Date.now();
  const names = readNames();
  const confirmed = readConfirmed();
  const sessions = [...new Set(panes.map(p => p.sessionName))];
  const { tabMap, activeSession: wzActiveSession } = await weztermMap(sessions);

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
    // Skip capturePane for idle shells — no useful output to capture
    const isIdleShell = IDLE_SHELLS.has((pane.command || '').toLowerCase());
    const output = isIdleShell ? '' : await capturePane(pane.paneId);
    const info = agentInfo.get(pane.paneId);
    const hasActiveChildren = info ? info.hasActiveChildren : undefined;
    const st = statusForPane(pane, output, now, hasActiveChildren);
    // Ensure front exists for every session with panes
    if (!frontsMap.has(pane.sessionName)) {
      frontsMap.set(pane.sessionName, {
        name: names[pane.sessionName] || pane.sessionName,
        sessionName: pane.sessionName,
        weztermTabId: tabMap[pane.sessionName] ?? null,
        aiSuggested: !!(names[pane.sessionName] && names[pane.sessionName] !== pane.sessionName && !confirmed[pane.sessionName]),
        activePaneId: null,
        agents: [],
        editorPanes: []
      });
    }

    // Track the active pane for this session (deterministic: each session always has one)
    if (pane.isWindowActive) {
      frontsMap.get(pane.sessionName).activePaneId = pane.paneId;
    }

    // Track editor panes (vim/nvim) separately — not as agents
    if (!st) {
      const cmd = pane.command.toLowerCase();
      if (cmd === 'vim' || cmd === 'nvim') {
        frontsMap.get(pane.sessionName).editorPanes.push({
          paneId: pane.paneId,
          windowName: pane.windowName,
          command: pane.command,
          panePath: pane.panePath
        });
      }
      continue;
    }

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
      panePath: pane.panePath,
      claudeSessionId: paneClaudeSessionIds.get(pane.paneId) || resolveClaudeSessionFromFs(pane.panePath),
      responseCard: paneResponseCards.get(pane.paneId) || null
    });
  }

  const fronts = [...frontsMap.values()].map(f => {
    // Derive projectDir from the most frequent panePath basename (agents + editors)
    const pathCounts = {};
    for (const a of [...f.agents, ...f.editorPanes]) {
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

  // Prefer WezTerm's focused tab to determine the active session
  const activePaneObj = wzActiveSession
    ? panes.find(p => p.isActive && p.sessionName === wzActiveSession)
    : panes.find(p => p.isActive);
  const activeSessionName = wzActiveSession || (activePaneObj ? activePaneObj.sessionName : null);

  return {
    fronts,
    activePane: activePaneObj ? activePaneObj.paneId : null,
    activeSessionName,
    summary: {
      total: fronts.length,
      totalAgents: fronts.reduce((n, f) => n + f.agents.length, 0),
      waiting: waitingAgents.length,
      oldestWaiting: waitingAgents[0] ? { frontName: waitingAgents[0].frontName, paneId: waitingAgents[0].paneId, waitingSince: waitingAgents[0].waitingSince } : null
    }
  };
}

// ── WebSocket server ──────────────────────────────────────────────────────

const wss = new WebSocket.Server({ host: '0.0.0.0', port: PORT });
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

// Debug + API HTTP server
const http = require('http');
const MOBILE_HTML = path.join(__dirname, 'mobile.html');
http.createServer(async (req, res) => {
  // ── CORS for mobile client ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET / or /mobile — serve mobile PWA ──
  if (req.method === 'GET' && (req.url === '/' || req.url === '/mobile')) {
    try {
      const html = fs.readFileSync(MOBILE_HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('mobile.html not found');
    }
    return;
  }

  // ── POST /hook-stop — Claude Code hook signals agent stopped ──
  if (req.method === 'POST' && req.url === '/hook-stop') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { paneId, cwd, sessionId, lastAssistantMessage, terminalSnapshot } = JSON.parse(body);
        if (!paneId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'missing paneId' })); return; }

        const prevStatus = prevPaneStatus.get(paneId);
        hookWaitingOverride.set(paneId, { timestamp: Date.now(), cwd: cwd || '', sessionId: sessionId || '' });
        if (sessionId) { paneClaudeSessionIds.set(paneId, sessionId); savePaneClaudeSessions(); }
        console.log(`[helm] hook-stop: pane=${paneId} prev=${prevStatus || 'unknown'} sessionId=${sessionId || '(none)'}`);

        // Parse response card from hook data
        if (lastAssistantMessage || terminalSnapshot) {
          const card = parseResponseCard(terminalSnapshot || '', lastAssistantMessage || '');
          paneResponseCards.set(paneId, card);
          console.log(`[helm] hook-stop: responseCard type=${card.type} for pane=${paneId}`);
        }

        // If transitioning running→waiting, generate wait summary (fire-and-forget)
        if (prevStatus === 'running') {
          const output = await capturePane(paneId);
          const panes = await listTmuxPanes();
          const pane = panes?.find(p => p.paneId === paneId);
          if (pane) generateWaitSummary(paneId, output, pane.panePath);
        }

        // Force immediate broadcast
        cachedStateJson = '{}';
        tick();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── POST /hook-notification — Claude Code notification hook (permissions, dialogs) ──
  if (req.method === 'POST' && req.url === '/hook-notification') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { paneId, message, terminalSnapshot } = JSON.parse(body);
        if (!paneId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'missing paneId' })); return; }

        // Mark as waiting via hook override
        hookWaitingOverride.set(paneId, { timestamp: Date.now(), cwd: '', sessionId: '' });

        // Parse response card from notification data
        const card = parseResponseCard(terminalSnapshot || '', message || '');
        paneResponseCards.set(paneId, card);
        console.log(`[helm] hook-notification: pane=${paneId} type=${card.type} message=${(message || '').slice(0, 60)}`);

        // Force immediate broadcast
        cachedStateJson = '{}';
        tick();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── POST /manual-rename-agent — user-provided name ──
  if (req.method === 'POST' && req.url === '/manual-rename-agent') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { paneId, name } = JSON.parse(body);
        if (!paneId || !name) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'missing paneId or name' })); return; }
        paneTaskNames.set(paneId, name);
        savePaneTasks();
        cachedStateJson = '{}';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── POST /rename-agent — AI rename based on major front ──
  if (req.method === 'POST' && req.url === '/rename-agent') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { paneId } = JSON.parse(body);
        if (!paneId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'missing paneId' })); return; }

        const output = await capturePane(paneId);
        const startOutput = await capturePaneStart(paneId);
        const panes = await listTmuxPanes();
        const pane = panes?.find(p => p.paneId === paneId);
        const panePath = pane?.panePath || '';
        const projectDir = panePath ? path.basename(panePath) : '(unknown)';

        const prompt = `You are looking at an AI coding agent session. Identify the MAJOR FRONT of work (the broad theme/goal), NOT the specific current detail or step.

Examples of good names (broad front): "auth system", "overlay ui", "daemon polling", "agent rename"
Examples of bad names (too specific): "fix bug line 42", "add try-catch", "update variable name"

Project: ${projectDir}

Session start:
${startOutput.slice(0, 2000)}

Recent output:
${output.slice(-1500)}

Reply with ONLY a 2-4 word lowercase task name describing the major front of work. No sentences, no explanations, no articles. Just the name.`;

        const raw = await askClaude(prompt);
        const name = cleanTaskName(raw, null);
        if (name) {
          paneTaskNames.set(paneId, name);
          savePaneTasks();
          // Force broadcast so UI updates immediately
          cachedStateJson = '{}';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'AI returned empty' }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── POST /send-keys — send text to a tmux pane ──
  if (req.method === 'POST' && req.url === '/send-keys') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { paneId, text } = JSON.parse(body);
        if (!paneId || text == null) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'missing paneId or text' })); return; }

        // Send literal text then Enter
        const sendRes = await execCmd('tmux', ['send-keys', '-t', paneId, '-l', text]);
        if (!sendRes.ok) throw new Error('send-keys literal failed: ' + sendRes.stderr);
        const enterRes = await execCmd('tmux', ['send-keys', '-t', paneId, 'Enter']);
        if (!enterRes.ok) throw new Error('send-keys Enter failed: ' + enterRes.stderr);

        // Clear hook override and response card — user responded, agent is working
        hookWaitingOverride.delete(paneId);
        paneWaitSummaries.delete(paneId);
        paneResponseCards.delete(paneId);
        console.log(`[helm] send-keys: pane=${paneId} text=${text.slice(0, 60)}${text.length > 60 ? '...' : ''}`);

        // Force immediate broadcast
        cachedStateJson = '{}';
        tick();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('[helm] send-keys error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── GET /debug — raw pane captures + detection results ──
  if (req.url !== '/debug') { res.writeHead(404); res.end(); return; }
  const panes = await listTmuxPanes();
  if (!panes) { res.writeHead(200); res.end('no tmux panes\n'); return; }
  const lines = [];
  for (const p of panes) {
    const output = await capturePane(p.paneId);
    const allLines = output.split('\n');
    // Find actual last content line (skip status bar and separator lines)
    let lastLine = allLines[allLines.length - 1] || '';
    for (let i = allLines.length - 1; i >= 0; i--) {
      const cl = stripAnsi(allLines[i]).trim();
      if (cl && !cl.startsWith('⏵') && !cl.startsWith('───')) { lastLine = allLines[i]; break; }
    }
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
}).listen(7374, '0.0.0.0');
console.log('HTTP + API: http://0.0.0.0:7374 (mobile: /, debug: /debug)');

ensureFiles();
loadPaneTasks();
loadPaneClaudeSessions();
// Use setTimeout loop (not setInterval) to prevent tick overlap when tick takes >POLL_MS
(async function tickLoop() {
  await tick();
  setTimeout(tickLoop, POLL_MS);
})();

console.log(`Helm daemon running on ws://localhost:${PORT}`);

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');
const WebSocket = require('ws');
const worktree = require('./worktree');

// Ignore EPIPE on stdout/stderr — happens when launched via `open` and the
// parent pipe disappears.  Without this, any console.log can crash the app.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });
}

let win;
let watermarkWin;
let daemonSocket;
let latestState = { fronts: [], activePane: null, summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };
let lastWatermarkData = { glyph: null, colorIdx: 0 };
let isWezterm = false;

// ── Daemon API helper (auto-detects HTTP vs HTTPS) ─────────────────────────
const CERT_DIR = path.join(os.homedir(), '.helm', 'certs');
const CERT_DOMAIN = 'macbook-pro-de-tiago.tail8a488e.ts.net';
let _daemonUseTls = null; // cached detection

function daemonUseTls() {
  if (_daemonUseTls === null) {
    try {
      fs.accessSync(path.join(CERT_DIR, CERT_DOMAIN + '.crt'));
      fs.accessSync(path.join(CERT_DIR, CERT_DOMAIN + '.key'));
      _daemonUseTls = true;
    } catch {
      _daemonUseTls = false;
    }
  }
  return _daemonUseTls;
}

function daemonPost(urlPath, payload, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const mod = daemonUseTls() ? require('https') : require('http');
    const protocol = daemonUseTls() ? 'https' : 'http';
    const req = mod.request(`${protocol}://127.0.0.1:7374${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      rejectUnauthorized: false // self-signed cert
    }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ ok: false, error: 'parse error' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

const helmDir = path.join(os.homedir(), '.helm');
const namesFile = path.join(helmDir, 'session-names.json');
const pillPosFile = path.join(helmDir, 'pill-position.json');
const helmNotifierBin = path.join(helmDir, 'HelmAlert.app', 'Contents', 'MacOS', 'terminal-notifier');
const paneWorktreesFile = path.join(helmDir, 'pane-worktrees.json');

function readWorktreeMapping() { return readJson(paneWorktreesFile); }
function writeWorktreeMapping(data) { writeJson(paneWorktreesFile, data); }

const sysEnv = {
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':')
};

// ── WezTerm binary detection ──────────────────────────────────────────────
const WEZTERM_CANDIDATES = [
  '/Applications/WezTerm.app/Contents/MacOS/wezterm',
  '/opt/homebrew/bin/wezterm',
  '/usr/local/bin/wezterm'
];
const weztermBin = WEZTERM_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
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

// ── Helpers ───────────────────────────────────────────────────────────────
function runFile(file, args = [], silent = false) {
  const env = { ...sysEnv };
  if (file === weztermBin) {
    const sock = findWeztermSocket();
    if (sock) env.WEZTERM_UNIX_SOCKET = sock;
  }
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 4000, env }, (error, stdout, stderr) => {
      if (error && !silent) console.error(`[helm] ${path.basename(file)} ${args[0] || ''}:`, error.message);
      resolve({ ok: !error, error, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// ── AeroSpace IPC via Unix socket (CLI hangs inside Electron) ────────────
const AERO_SOCK = `/tmp/bobko.aerospace-${os.userInfo().username}.sock`;

function aeroCmd(args) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => { if (!resolved) { resolved = true; resolve(result); } };

    const sock = net.createConnection(AERO_SOCK, () => {
      sock.write(JSON.stringify({ command: '', args, stdin: '' }));
      sock.end();
    });
    const chunks = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        const first = raw.indexOf('{');
        const brace = findMatchingBrace(raw, first);
        const res = JSON.parse(raw.substring(first, brace + 1));
        done({ ok: res.exitCode === 0, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() });
      } catch (e) { done({ ok: false, stdout: '', stderr: 'parse: ' + e.message }); }
    });
    sock.on('error', (e) => done({ ok: false, stdout: '', stderr: e.message }));
    sock.setTimeout(3000, () => { sock.destroy(); done({ ok: false, stdout: '', stderr: 'timeout' }); });
  });
}

function findMatchingBrace(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return str.length - 1;
}

function ensureDir() {
  try {
    if (!fs.existsSync(helmDir)) fs.mkdirSync(helmDir, { recursive: true });
    if (!fs.existsSync(namesFile)) fs.writeFileSync(namesFile, '{}\n', 'utf8');
  } catch (e) { console.error('[helm] ensureDir:', e.message); }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); } catch { return {}; }
}

function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('[helm] writeJson:', e.message); }
}

// ── Terminal bundle IDs ───────────────────────────────────────────────────
const TERMINAL_BUNDLE_IDS = new Set([
  'com.github.wez.wezterm',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'net.kovidgoyal.kitty',
  'co.zeit.hyper',
  'com.github.Electron'   // Helm itself (clicking on the pill)
]);

// ── AeroSpace workspace tracking & active-app detection ──────────────────
let aeroWindowId = null;
let aeroWatermarkId = null;
let lastWorkspace = null;
let lastActiveApp = null;
let lastExternalApp = null; // last non-Helm app (to restore focus)

function startOverlayTracking() {
  // Resolve our AeroSpace window IDs once the windows are ready
  setTimeout(async () => {
    const res = await aeroCmd(['list-windows', '--all']);
    if (res.ok && res.stdout) {
      for (const line of res.stdout.split('\n')) {
        if (line.includes('Helm HUD')) {
          const match = line.match(/^(\d+)/);
          if (match && !aeroWindowId) { aeroWindowId = match[1]; }
        } else if (line.includes('Helm Watermark')) {
          const match = line.match(/^(\d+)/);
          if (match) { aeroWatermarkId = match[1]; }
        }
      }
    }
  }, 2000);

  // Fast poll: workspace tracking (50ms — socket IPC ~10ms, so max flicker ~60ms)
  setInterval(async () => {
    const { ok, stdout: ws } = await aeroCmd(['list-workspaces', '--focused']);
    if (ok && ws && ws !== lastWorkspace) {
      lastWorkspace = ws;
      if (aeroWindowId) {
        await aeroCmd(['move-node-to-workspace', ws, '--window-id', aeroWindowId]);
        if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
      }
      if (aeroWatermarkId) {
        await aeroCmd(['move-node-to-workspace', ws, '--window-id', aeroWatermarkId]);
        if (watermarkWin && !watermarkWin.isDestroyed()) watermarkWin.setAlwaysOnTop(true, 'pop-up-menu');
      }
    }
  }, 500);

  // Slow poll: active app detection (500ms — uses osascript, heavier)
  setInterval(async () => {
    const { ok, stdout: appId } = await runFile('osascript', [
      '-e', 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'
    ], true);
    if (ok && appId && appId !== lastActiveApp) {
      lastActiveApp = appId;
      if (appId !== 'com.github.Electron') lastExternalApp = appId;
      const isTerminal = TERMINAL_BUNDLE_IDS.has(appId);
      isWezterm = appId === 'com.github.wez.wezterm';
      if (win && !win.isDestroyed()) {
        win.webContents.send('active-app-changed', { appId, isTerminal });
      }
      // Update watermark visibility
      if (watermarkWin && !watermarkWin.isDestroyed()) {
        watermarkWin.webContents.send('watermark-update', { ...lastWatermarkData, visible: isWezterm && !!lastWatermarkData.glyph });
      }
    }
  }, 2000);
}

// ── Pill position persistence ─────────────────────────────────────────────
function loadPillPosition() {
  // Always center horizontally at top of screen
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + Math.round((workArea.width - PILL_W) / 2), y: workArea.y + 10 };
}

function savePillPosition(x, y) {
  writeJson(pillPosFile, { x, y });
}

// ── Window ────────────────────────────────────────────────────────────────
const PILL_W = 280;
const PILL_H = 98; // pill (42) + active glyph (34) + gap (6) + padding (16)
const PANEL_W = 1200;
const SUMMARY_RESERVE = 220; // space below panel for summary panel + connector
const GAP = 8;
let currentLayout = null;

function computeExpandedBounds(pillX, pillY, actualPillW) {
  const { workArea } = screen.getPrimaryDisplay();
  const pillW = actualPillW || PILL_W;

  // Horizontal: center panel on pill's visual center, clamp to screen
  let px = pillX + Math.round(pillW / 2) - Math.round(PANEL_W / 2);
  px = Math.max(workArea.x, Math.min(px, workArea.x + workArea.width - PANEL_W));

  // Vertical: prefer below pill, flip above if not enough space
  const spaceBelow = (workArea.y + workArea.height) - (pillY + PILL_H + GAP);
  const spaceAbove = pillY - workArea.y - GAP;
  const panelBelow = spaceBelow >= 300 || spaceBelow >= spaceAbove;

  // Dynamic panel height: use available space minus summary reserve
  const availableSpace = panelBelow ? spaceBelow : spaceAbove;
  const panelH = Math.max(200, availableSpace - SUMMARY_RESERVE);

  let winY, winH;
  if (panelBelow) {
    winY = pillY;
    winH = PILL_H + GAP + panelH + SUMMARY_RESERVE;
    // Clamp to screen bottom
    const maxH = (workArea.y + workArea.height) - winY;
    winH = Math.min(winH, maxH);
  } else {
    winY = pillY - GAP - panelH;
    winY = Math.max(workArea.y, winY);
    winH = (pillY + PILL_H) - winY;
  }

  const winX = Math.min(pillX, px);
  const winW = Math.max(pillX + PILL_W, px + PANEL_W) - winX;

  return {
    winBounds: { x: winX, y: winY, width: winW, height: winH },
    layout: {
      pillOffsetX: pillX - winX,
      pillOffsetY: pillY - winY,
      panelOffsetX: px - winX,
      panelOffsetY: panelBelow ? (pillY + PILL_H + GAP) - winY : 0,
      panelW: PANEL_W,
      panelH: panelH
    }
  };
}

function createWindow() {
  const pos = loadPillPosition();
  // Window is always at expanded size — toggle is CSS-only (no resize = no flash)
  const { winBounds, layout } = computeExpandedBounds(pos.x, pos.y);
  currentLayout = layout;

  win = new BrowserWindow({
    width: winBounds.width,
    height: winBounds.height,
    x: winBounds.x,
    y: winBounds.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // screen-saver is the highest level in Electron on macOS
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Re-assert when window loses focus (Aerospace / other WMs can steal z-order)
  win.on('blur', () => {
    if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
  });


  win.loadFile(path.join(__dirname, 'renderer/index.html'));

  win.once('ready-to-show', () => {
    // Start with passthrough — renderer toggles on hover via elementFromPoint
    win.setIgnoreMouseEvents(true, { forward: true });
    win.show();
  });

  // ── Watermark window (fullscreen, transparent, non-interactive) ────────
  const { workArea } = screen.getPrimaryDisplay();
  watermarkWin = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'watermark-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  watermarkWin.setAlwaysOnTop(true, 'pop-up-menu');
  watermarkWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  watermarkWin.setIgnoreMouseEvents(true);
  watermarkWin.loadFile(path.join(__dirname, 'renderer/watermark.html'));
  watermarkWin.once('ready-to-show', () => watermarkWin.show());
}

// ── Daemon WebSocket ──────────────────────────────────────────────────────
function connectDaemon() {
  if (daemonSocket) { try { daemonSocket.terminate(); } catch {} }

  daemonSocket = new WebSocket('ws://127.0.0.1:7373');
  daemonSocket.on('message', (msg) => {
    try {
      const prev = latestState;
      latestState = JSON.parse(msg.toString());
      if (win && !win.isDestroyed()) win.webContents.send('state-update', latestState);

      // Notify when agent transitions running → waiting
      const prevAgents = new Map();
      for (const f of (prev.fronts || [])) {
        for (const a of f.agents) prevAgents.set(a.paneId, { ...a, frontName: f.name });
      }
      for (const f of latestState.fronts) {
        for (const a of f.agents) {
          const pa = prevAgents.get(a.paneId);
          if (pa && pa.status === 'running' && a.status === 'waiting') {
            execFile(helmNotifierBin, [
              '-title', f.name || 'Helm',
              '-message', `${a.task || a.command} terminou`,
              '-sound', 'Pop',
              '-group', `helm-${a.paneId}`
            ], { env: sysEnv }, () => {});
          }
        }
      }
    } catch (e) { console.error('[helm] ws parse:', e.message); }
  });
  daemonSocket.on('close', () => setTimeout(connectDaemon, 2500));
  daemonSocket.on('error', () => setTimeout(connectDaemon, 2500));
}

// ── Renderer hot reload ──────────────────────────────────────────────────
function watchRenderer() {
  const dir = path.join(__dirname, 'renderer');
  const mtimes = new Map();
  let timer;
  fs.watch(dir, { recursive: true }, (_ev, filename) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!filename) return;
      const file = path.join(dir, filename);
      let mtime;
      try { mtime = fs.statSync(file).mtimeMs; } catch { return; }
      if (mtimes.get(file) === mtime) return;
      mtimes.set(file, mtime);
      if (win && !win.isDestroyed()) {
        console.log('[helm] renderer changed, reloading...');
        win.webContents.reloadIgnoringCache();
      }
      if (watermarkWin && !watermarkWin.isDestroyed()) {
        watermarkWin.webContents.reloadIgnoringCache();
      }
    }, 300);
  });
}

// ── App bootstrap ─────────────────────────────────────────────────────────
app.setName('Helm');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[helm] Another instance is already running, quitting.');
  app.quit();
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide(); // accessory app — never steals focus
  ensureDir();
  createWindow();
  connectDaemon();
  if (process.env.HELM_DEV) watchRenderer();
  startOverlayTracking();
  globalShortcut.register('Control+H', () => {
    if (win && !win.isDestroyed()) {
      win.setFocusable(true);
      win.focus();
      win.webContents.send('shortcut-fired');
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (daemonSocket) { try { daemonSocket.terminate(); } catch {} }
});

app.on('window-all-closed', () => app.quit());

// ── IPC handlers ──────────────────────────────────────────────────────────
// Returns current layout (no resize)
ipcMain.on('get-layout', (e) => {
  e.returnValue = currentLayout;
});

// Recalculate bounds after drag — window is always at expanded size
ipcMain.on('recalculate-bounds', (e) => {
  if (!win || win.isDestroyed()) { e.returnValue = null; return; }

  const [wx, wy] = win.getPosition();
  const pillX = wx + (currentLayout ? currentLayout.pillOffsetX : 0);
  const pillY = wy + (currentLayout ? currentLayout.pillOffsetY : 0);

  const { winBounds, layout } = computeExpandedBounds(pillX, pillY);
  currentLayout = layout;
  win.setBounds(winBounds, false);
  e.returnValue = layout;
});

ipcMain.on('move-window', (_e, dx, dy) => {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
});

ipcMain.on('refocus-previous-app', () => {
  if (lastExternalApp) {
    runFile('osascript', [
      '-e', `tell application id "${lastExternalApp}" to activate`
    ], true);
  }
});

ipcMain.on('debug-log', (_e, msg) => {
  const fs = require('fs');
  fs.appendFileSync(path.join(os.homedir(), '.helm', 'debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
});

// Watermark data from renderer → forward to watermark window
ipcMain.on('update-watermark', (_e, data) => {
  lastWatermarkData = data;
  if (watermarkWin && !watermarkWin.isDestroyed()) {
    watermarkWin.webContents.send('watermark-update', { ...data, visible: isWezterm && !!data.glyph });
  }
});

ipcMain.on('blur-window', () => {
  if (win && !win.isDestroyed()) win.setFocusable(false);
  if (lastExternalApp) {
    runFile('osascript', ['-e', `tell application id "${lastExternalApp}" to activate`], true);
  }
});

ipcMain.on('save-pill-position', (_e, x, y) => {
  if (x == null || y == null) {
    // Derive pill screen position from window position + layout offset
    if (win && !win.isDestroyed() && currentLayout) {
      const [wx, wy] = win.getPosition();
      savePillPosition(wx + currentLayout.pillOffsetX, wy + currentLayout.pillOffsetY);
    }
  } else {
    savePillPosition(x, y);
  }
});

ipcMain.handle('get-pill-position', () => {
  return loadPillPosition();
});

ipcMain.on('set-ignore-mouse', (e, ignore) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!ignore, { forward: true });
  e.returnValue = null; // required for sendSync to unblock renderer immediately
});

ipcMain.on('navigate-to-pane', async (_e, sessionName, windowName, paneId, weztermTabId) => {
  console.log('[helm] navigate →', { sessionName, windowName, paneId, weztermTabId });

  // Step 1: select tmux window + pane via paneId (globally unique, avoids
  // ambiguity when multiple windows share the same name like "bash")
  if (paneId) {
    const rw = await runFile('tmux', ['select-window', '-t', String(paneId)]);
    console.log('[helm] select-window:', rw.ok ? 'ok' : rw.error?.message);
    const rp = await runFile('tmux', ['select-pane', '-t', String(paneId)]);
    console.log('[helm] select-pane:', rp.ok ? 'ok' : rp.error?.message);
  } else if (sessionName && windowName) {
    const r = await runFile('tmux', ['select-window', '-t', `${sessionName}:${windowName}`]);
    console.log('[helm] select-window (fallback):', r.ok ? 'ok' : r.error?.message);
  }

  // Step 2: activate WezTerm tab if we have the id
  if (weztermTabId != null && weztermBin) {
    const r = await runFile(weztermBin, ['cli', 'activate-tab', '--tab-id', String(weztermTabId)], true);
    console.log('[helm] activate-tab:', r.ok ? 'ok' : r.error?.message);
  }

  // Step 3: always bring WezTerm window to front via AppleScript
  await runFile('osascript', ['-e', 'tell application "WezTerm" to activate'], true);
});

ipcMain.on('confirm-name', (_e, sessionName, name) => {
  if (!sessionName || !name) return;
  const names = readJson(namesFile);
  names[sessionName] = String(name).trim();
  writeJson(namesFile, names);

  const confirmedFile = path.join(helmDir, 'confirmed-names.json');
  const confirmed = readJson(confirmedFile);
  confirmed[sessionName] = true;
  writeJson(confirmedFile, confirmed);
});

ipcMain.on('save-front-order', (_e, order) => {
  if (!Array.isArray(order)) return;
  writeJson(path.join(helmDir, 'front-order.json'), order);
});

ipcMain.handle('get-state', () => latestState);

ipcMain.handle('get-front-order', () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(helmDir, 'front-order.json'), 'utf8'));
  } catch { return []; }
});

// ── Session/window management ──────────────────────────────────────────────
ipcMain.handle('create-session', async (_e, name) => {
  if (!name || typeof name !== 'string') return { ok: false, error: 'invalid name' };
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safe) return { ok: false, error: 'invalid name after sanitize' };

  // Resolve project directory via zoxide
  const zRes = await runFile('zoxide', ['query', name], true);
  const cwd = (zRes.ok && zRes.stdout) ? zRes.stdout : os.homedir();

  const r = await runFile('tmux', ['new-session', '-d', '-s', safe, '-c', cwd]);
  if (!r.ok) return { ok: false, error: r.stderr || r.error?.message };

  // Start nvim in window 0 (stays in original repo)
  await runFile('tmux', ['send-keys', '-t', `${safe}:0`, 'nvim', 'Enter'], true);

  // Create worktree for window 1 (agent) if cwd is a git repo
  let agentCwd = cwd;
  if (worktree.isGitRepo(cwd)) {
    const repoRoot = worktree.getRepoRoot(cwd) || cwd;
    const branch = `helm/${safe}/1`;
    const wt = worktree.createWorktree(repoRoot, branch);
    if (wt.ok) {
      agentCwd = wt.worktreePath;
      console.log(`[helm] worktree created: ${wt.worktreePath} (branch: ${wt.branch})`);
    }
  }

  // Create window 1 with claude and focus on it
  await runFile('tmux', ['new-window', '-t', safe, '-c', agentCwd], true);
  await runFile('tmux', ['send-keys', '-t', `${safe}:1`, 'claude', 'Enter'], true);
  await runFile('tmux', ['select-window', '-t', `${safe}:1`], true);

  // Capture paneId of the new window and save worktree mapping
  if (agentCwd !== cwd) {
    const paneIdRes = await runFile('tmux', ['display-message', '-t', `${safe}:1`, '-p', '#{pane_id}'], true);
    if (paneIdRes.ok && paneIdRes.stdout) {
      const mapping = readWorktreeMapping();
      mapping[paneIdRes.stdout] = {
        worktreePath: agentCwd,
        branch: `helm/${safe}/1`,
        repoPath: worktree.getRepoRoot(cwd) || cwd,
        sessionName: safe
      };
      writeWorktreeMapping(mapping);
    }
  }

  // Open in WezTerm (as a new tab in the current window)
  if (weztermBin) {
    const spawnArgs = ['cli', 'spawn', '--cwd', cwd];
    const listRes = await runFile(weztermBin, ['cli', 'list', '--format', 'json'], true);
    if (listRes.ok && listRes.stdout) {
      try {
        const active = JSON.parse(listRes.stdout).find(i => i.is_active);
        if (active) spawnArgs.push('--window-id', String(active.window_id));
      } catch {}
    }
    spawnArgs.push('--', 'tmux', 'attach', '-t', safe);
    await runFile(weztermBin, spawnArgs, true);
    await runFile('osascript', ['-e', 'tell application "WezTerm" to activate'], true);
  }
  return { ok: true };
});

ipcMain.handle('create-window', async (_e, sessionName, weztermTabId) => {
  if (!sessionName) return { ok: false, error: 'missing sessionName' };
  // Get the current path of the active pane in this session
  const pathRes = await runFile('tmux', ['display-message', '-t', sessionName, '-p', '#{pane_current_path}'], true);
  const cwd = pathRes.ok && pathRes.stdout ? pathRes.stdout : os.homedir();

  // Create worktree for new agent window if cwd is a git repo
  let agentCwd = cwd;
  let wtBranch = null;
  let repoRoot = null;
  if (worktree.isGitRepo(cwd)) {
    repoRoot = worktree.getRepoRoot(cwd) || cwd;
    // Determine window index by counting existing windows
    const listRes = await runFile('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_index}'], true);
    const windowCount = listRes.ok ? listRes.stdout.split('\n').filter(Boolean).length : 1;
    const windowIdx = windowCount; // new window will be at this index
    wtBranch = `helm/${sessionName}/${windowIdx}`;
    const wt = worktree.createWorktree(repoRoot, wtBranch);
    if (wt.ok) {
      agentCwd = wt.worktreePath;
      wtBranch = wt.branch;
      console.log(`[helm] worktree created: ${wt.worktreePath} (branch: ${wt.branch})`);
    } else {
      wtBranch = null;
    }
  }

  const r = await runFile('tmux', ['new-window', '-t', sessionName, '-c', agentCwd]);
  if (!r.ok) return { ok: false, error: r.stderr || r.error?.message };

  // Save worktree mapping if worktree was created
  if (agentCwd !== cwd && wtBranch) {
    // Get paneId of the newly created window (last window)
    const newPaneRes = await runFile('tmux', ['display-message', '-t', sessionName, '-p', '#{pane_id}'], true);
    if (newPaneRes.ok && newPaneRes.stdout) {
      const mapping = readWorktreeMapping();
      mapping[newPaneRes.stdout] = {
        worktreePath: agentCwd,
        branch: wtBranch,
        repoPath: repoRoot,
        sessionName
      };
      writeWorktreeMapping(mapping);
    }
  }

  // Focus the WezTerm tab and bring it to front
  if (weztermTabId != null && weztermBin) {
    await runFile(weztermBin, ['cli', 'activate-tab', '--tab-id', String(weztermTabId)], true);
  }
  await runFile('osascript', ['-e', 'tell application "WezTerm" to activate'], true);
  return { ok: true };
});

ipcMain.handle('fork-session', async (_e, sessionName, claudeSessionId, panePath, weztermTabId) => {
  if (!sessionName || !claudeSessionId) return { ok: false, error: 'missing sessionName or claudeSessionId' };
  const cwd = panePath || os.homedir();

  // Create worktree for forked session
  let agentCwd = cwd;
  let wtBranch = null;
  let repoRoot = null;
  if (worktree.isGitRepo(cwd)) {
    repoRoot = worktree.getRepoRoot(cwd) || cwd;
    wtBranch = `helm/${sessionName}/fork-${Date.now()}`;
    const wt = worktree.createWorktree(repoRoot, wtBranch);
    if (wt.ok) {
      agentCwd = wt.worktreePath;
      wtBranch = wt.branch;
      console.log(`[helm] fork worktree created: ${wt.worktreePath} (branch: ${wt.branch})`);
    } else {
      wtBranch = null;
    }
  }

  const r = await runFile('tmux', ['new-window', '-t', sessionName, '-c', agentCwd]);
  if (!r.ok) return { ok: false, error: r.stderr || r.error?.message };
  // Send the fork command to the new window's shell
  await runFile('tmux', ['send-keys', '-t', sessionName, `claude --resume ${claudeSessionId} --fork-session`, 'Enter']);

  // Save worktree mapping
  if (agentCwd !== cwd && wtBranch) {
    const newPaneRes = await runFile('tmux', ['display-message', '-t', sessionName, '-p', '#{pane_id}'], true);
    if (newPaneRes.ok && newPaneRes.stdout) {
      const mapping = readWorktreeMapping();
      mapping[newPaneRes.stdout] = {
        worktreePath: agentCwd,
        branch: wtBranch,
        repoPath: repoRoot,
        sessionName
      };
      writeWorktreeMapping(mapping);
    }
  }

  // Focus WezTerm tab and bring to front
  if (weztermTabId != null && weztermBin) {
    await runFile(weztermBin, ['cli', 'activate-tab', '--tab-id', String(weztermTabId)], true);
  }
  await runFile('osascript', ['-e', 'tell application "WezTerm" to activate'], true);
  return { ok: true };
});

ipcMain.handle('kill-session', async (_e, sessionName) => {
  if (!sessionName) return { ok: false, error: 'missing sessionName' };

  // Cleanup worktrees for all panes in this session
  const mapping = readWorktreeMapping();
  for (const [paneId, entry] of Object.entries(mapping)) {
    if (entry.sessionName === sessionName) {
      worktree.migrateClaudeSessions(entry.worktreePath, entry.repoPath);
      worktree.removeWorktree(entry.repoPath, entry.worktreePath);
      worktree.removeBranch(entry.repoPath, entry.branch);
      delete mapping[paneId];
      console.log(`[helm] worktree cleaned up: ${entry.worktreePath}`);
    }
  }
  writeWorktreeMapping(mapping);

  const r = await runFile('tmux', ['kill-session', '-t', sessionName]);
  if (!r.ok) return { ok: false, error: r.stderr || r.error?.message };
  return { ok: true };
});

ipcMain.handle('kill-window', async (_e, paneId) => {
  if (!paneId) return { ok: false, error: 'missing paneId' };

  // Cleanup worktree for this pane
  const mapping = readWorktreeMapping();
  const entry = mapping[paneId];
  if (entry) {
    worktree.migrateClaudeSessions(entry.worktreePath, entry.repoPath);
    worktree.removeWorktree(entry.repoPath, entry.worktreePath);
    worktree.removeBranch(entry.repoPath, entry.branch);
    delete mapping[paneId];
    writeWorktreeMapping(mapping);
    console.log(`[helm] worktree cleaned up: ${entry.worktreePath}`);
  }

  const r = await runFile('tmux', ['kill-window', '-t', String(paneId)]);
  if (!r.ok) return { ok: false, error: r.stderr || r.error?.message };
  return { ok: true };
});

ipcMain.handle('rename-agent', async (_e, paneId) => {
  if (!paneId) return { ok: false, error: 'missing paneId' };
  return daemonPost('/rename-agent', { paneId }, 30000);
});

ipcMain.handle('manual-rename-agent', async (_e, paneId, name) => {
  if (!paneId || !name) return { ok: false, error: 'missing paneId or name' };
  return daemonPost('/manual-rename-agent', { paneId, name }, 5000);
});

ipcMain.handle('send-keys', async (_e, paneId, text) => {
  if (!paneId || text == null) return { ok: false, error: 'missing paneId or text' };
  return daemonPost('/send-keys', { paneId, text }, 10000);
});

ipcMain.handle('list-worktrees', () => {
  return readWorktreeMapping();
});

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');
const WebSocket = require('ws');

let win;
let daemonSocket;
let latestState = { fronts: [], activePane: null, summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };

const helmDir = path.join(os.homedir(), '.helm');
const namesFile = path.join(helmDir, 'session-names.json');
const pillPosFile = path.join(helmDir, 'pill-position.json');

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

// ── Helpers ───────────────────────────────────────────────────────────────
function runFile(file, args = [], silent = false) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 4000, env: sysEnv }, (error, stdout, stderr) => {
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
let lastWorkspace = null;
let lastActiveApp = null;
let lastExternalApp = null; // last non-Helm app (to restore focus)

function startOverlayTracking() {
  // Resolve our AeroSpace window ID once the window is ready
  setTimeout(async () => {
    const res = await aeroCmd(['list-windows', '--all']);
    if (res.ok && res.stdout) {
      for (const line of res.stdout.split('\n')) {
        if (line.includes('Helm HUD')) {
          const match = line.match(/^(\d+)/);
          if (match) { aeroWindowId = match[1]; break; }
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
      if (win && !win.isDestroyed()) {
        win.webContents.send('active-app-changed', { appId, isTerminal });
      }
    }
  }, 2000);
}

// ── Pill position persistence ─────────────────────────────────────────────
function loadPillPosition() {
  try {
    const data = JSON.parse(fs.readFileSync(pillPosFile, 'utf8'));
    if (typeof data.x === 'number' && typeof data.y === 'number') return data;
  } catch {}
  // Fallback: top-right corner
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - PILL_W - 20, y: workArea.y + 10 };
}

function savePillPosition(x, y) {
  writeJson(pillPosFile, { x, y });
}

// ── Window ────────────────────────────────────────────────────────────────
const PILL_W = 280;
const PILL_H = 56;
const PANEL_W = 990;
const PANEL_H = 620;  // fixed max — content scrolls inside
const GAP = 8;
let currentLayout = null;

function computeExpandedBounds(pillX, pillY) {
  const { workArea } = screen.getPrimaryDisplay();

  // Horizontal: center panel on pill, clamp to screen
  let px = pillX + Math.round(PILL_W / 2) - Math.round(PANEL_W / 2);
  px = Math.max(workArea.x, Math.min(px, workArea.x + workArea.width - PANEL_W));

  // Vertical: prefer below pill, flip above if not enough space
  const spaceBelow = (workArea.y + workArea.height) - (pillY + PILL_H + GAP);
  const spaceAbove = pillY - workArea.y - GAP;
  const panelBelow = spaceBelow >= PANEL_H || spaceBelow >= spaceAbove;

  let winY, winH;
  if (panelBelow) {
    winY = pillY;
    winH = PILL_H + GAP + PANEL_H;
  } else {
    winY = pillY - GAP - PANEL_H;
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
      panelH: PANEL_H
    }
  };
}

function createWindow() {
  const pos = loadPillPosition();
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
}

// ── Daemon WebSocket ──────────────────────────────────────────────────────
function connectDaemon() {
  if (daemonSocket) { try { daemonSocket.terminate(); } catch {} }

  daemonSocket = new WebSocket('ws://127.0.0.1:7373');
  daemonSocket.on('message', (msg) => {
    try {
      latestState = JSON.parse(msg.toString());
      if (win && !win.isDestroyed()) win.webContents.send('state-update', latestState);
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

// Recalculate bounds after drag — resizes window, returns new layout
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
  if (weztermTabId && weztermBin) {
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

  const r = await runFile('tmux', ['new-session', '-d', '-s', safe, '-c', os.homedir()]);
  if (!r.ok) return { ok: false, error: r.stderr || r.error?.message };

  // Open in WezTerm
  if (weztermBin) {
    await runFile(weztermBin, ['cli', 'spawn', '--cwd', os.homedir(), '--', 'tmux', 'attach', '-t', safe], true);
  }
  return { ok: true };
});

ipcMain.handle('create-window', async (_e, sessionName) => {
  if (!sessionName) return { ok: false, error: 'missing sessionName' };
  // Get the current path of the active pane in this session
  const pathRes = await runFile('tmux', ['display-message', '-t', sessionName, '-p', '#{pane_current_path}'], true);
  const cwd = pathRes.ok && pathRes.stdout ? pathRes.stdout : os.homedir();
  const r = await runFile('tmux', ['new-window', '-t', sessionName, '-c', cwd]);
  if (!r.ok) return { ok: false, error: r.stderr || r.error?.message };
  return { ok: true };
});

ipcMain.handle('kill-session', async (_e, sessionName) => {
  if (!sessionName) return { ok: false, error: 'missing sessionName' };
  const r = await runFile('tmux', ['kill-session', '-t', sessionName]);
  if (!r.ok) return { ok: false, error: r.stderr || r.error?.message };
  return { ok: true };
});

ipcMain.handle('kill-window', async (_e, paneId) => {
  if (!paneId) return { ok: false, error: 'missing paneId' };
  const r = await runFile('tmux', ['kill-window', '-t', String(paneId)]);
  if (!r.ok) return { ok: false, error: r.stderr || r.error?.message };
  return { ok: true };
});

ipcMain.handle('rename-agent', async (_e, paneId) => {
  if (!paneId) return { ok: false, error: 'missing paneId' };
  const http = require('http');
  return new Promise((resolve) => {
    const payload = JSON.stringify({ paneId });
    const req = http.request('http://127.0.0.1:7374/rename-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ ok: false, error: 'parse error' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
});

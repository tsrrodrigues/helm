const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');
const WebSocket = require('ws');

let win;
let daemonSocket;
let latestState = { fronts: [], summary: { total: 0, totalAgents: 0, waiting: 0, oldestWaiting: null } };

const helmDir = path.join(os.homedir(), '.helm');
const namesFile = path.join(helmDir, 'session-names.json');

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
  }, 50);

  // Slow poll: active app detection (500ms — uses osascript, heavier)
  setInterval(async () => {
    const { ok, stdout: appId } = await runFile('osascript', [
      '-e', 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'
    ], true);
    if (ok && appId && appId !== lastActiveApp) {
      lastActiveApp = appId;
      const isTerminal = TERMINAL_BUNDLE_IDS.has(appId);
      if (win && !win.isDestroyed()) {
        win.webContents.send('active-app-changed', { appId, isTerminal });
      }
    }
  }, 500);
}

// ── Window ────────────────────────────────────────────────────────────────
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 900;
  const x = Math.round(workArea.x + (workArea.width - width) / 2);

  win = new BrowserWindow({
    width,
    height: 52,
    x,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    focusable: true,
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

  // Periodic re-assert every 2s — ensures overlay survives workspace switches
  setInterval(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
  }, 2000);

  win.loadFile(path.join(__dirname, 'renderer/index.html'));

  win.once('ready-to-show', () => {
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

app.whenReady().then(() => {
  ensureDir();
  createWindow();
  connectDaemon();
  watchRenderer();
  startOverlayTracking();
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (win && !win.isDestroyed()) win.webContents.send('shortcut-fired');
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (daemonSocket) { try { daemonSocket.terminate(); } catch {} }
});

app.on('window-all-closed', () => app.quit());

// ── IPC handlers ──────────────────────────────────────────────────────────
ipcMain.on('resize-window', (_e, height) => {
  if (!win || win.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const width = 900;
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const h = Math.max(52, Math.min(620, Number(height) || 52));
  win.setBounds({ x, y: 0, width, height: h }, true);
});

ipcMain.on('set-ignore-mouse', (e, ignore) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!ignore, { forward: true });
  e.returnValue = null; // required for sendSync to unblock renderer immediately
});

ipcMain.on('navigate-to-pane', async (_e, sessionName, windowName, paneId, weztermTabId) => {
  console.log('[helm] navigate →', { sessionName, windowName, paneId, weztermTabId });

  // Step 1: select tmux window + pane first (works even without WezTerm tab id)
  if (sessionName && windowName) {
    const r = await runFile('tmux', ['select-window', '-t', `${sessionName}:${windowName}`]);
    console.log('[helm] select-window:', r.ok ? 'ok' : r.error?.message);
  }
  if (paneId) {
    const r = await runFile('tmux', ['select-pane', '-t', String(paneId)]);
    console.log('[helm] select-pane:', r.ok ? 'ok' : r.error?.message);
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

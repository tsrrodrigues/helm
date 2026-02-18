const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

// ── Window ────────────────────────────────────────────────────────────────
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 740;
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

// ── App bootstrap ─────────────────────────────────────────────────────────
app.setName('Helm');

app.whenReady().then(() => {
  ensureDir();
  createWindow();
  connectDaemon();
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
  const width = 740;
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

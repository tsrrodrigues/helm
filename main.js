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

// Include Homebrew paths so tmux/wezterm are found regardless of shell env
const sysEnv = {
  ...process.env,
  PATH: [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    process.env.PATH || ''
  ].join(':')
};

function runFile(file, args = []) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 4000, env: sysEnv }, (error, stdout, stderr) => {
      if (error) console.error(`runFile ${file}:`, error.message);
      resolve({ error, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

function ensureNamesFile() {
  try {
    if (!fs.existsSync(helmDir)) fs.mkdirSync(helmDir, { recursive: true });
    if (!fs.existsSync(namesFile)) fs.writeFileSync(namesFile, '{}\n', 'utf8');
  } catch (e) {
    console.error('Failed to initialize names file:', e.message);
  }
}

function saveSessionName(sessionName, name) {
  ensureNamesFile();
  try {
    const current = JSON.parse(fs.readFileSync(namesFile, 'utf8') || '{}');
    current[sessionName] = name;
    fs.writeFileSync(namesFile, JSON.stringify(current, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save session name:', e.message);
  }
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const x = Math.round(primaryDisplay.workArea.x + (primaryDisplay.workArea.width - 740) / 2);

  win = new BrowserWindow({
    width: 740,
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'pop-up-menu', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Re-assert always-on-top whenever any window gets focus (some apps steal it)
  app.on('browser-window-blur', () => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'pop-up-menu', 1);
  });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));

  win.once('ready-to-show', () => {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.show();
  });
}

function connectDaemon() {
  if (daemonSocket) {
    try { daemonSocket.terminate(); } catch {}
  }

  daemonSocket = new WebSocket('ws://127.0.0.1:7373');
  daemonSocket.on('message', (message) => {
    try {
      latestState = JSON.parse(message.toString());
      if (win && !win.isDestroyed()) win.webContents.send('state-update', latestState);
    } catch (e) {
      console.error('Invalid daemon payload:', e.message);
    }
  });

  daemonSocket.on('close', () => setTimeout(connectDaemon, 2500));
  daemonSocket.on('error', () => setTimeout(connectDaemon, 2500));
}

app.setName('Helm');

app.whenReady().then(() => {
  ensureNamesFile();
  createWindow();
  connectDaemon();

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (win && !win.isDestroyed()) win.webContents.send('shortcut-fired');
  });
});

ipcMain.on('resize-window', (_event, height) => {
  if (!win || win.isDestroyed()) return;
  const width = 740;
  const primaryDisplay = screen.getPrimaryDisplay();
  const x = Math.round(primaryDisplay.workArea.x + (primaryDisplay.workArea.width - width) / 2);
  const h = Math.max(52, Math.min(620, Number(height) || 52));
  win.setBounds({ x, y: 0, width, height: h }, true);
});

const WEZTERM_PATHS_MAIN = [
  '/Applications/WezTerm.app/Contents/MacOS/wezterm',
  '/opt/homebrew/bin/wezterm',
  '/usr/local/bin/wezterm'
];
const weztermBinMain = WEZTERM_PATHS_MAIN.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'wezterm';

ipcMain.on('navigate-to-pane', async (_event, sessionName, windowName, paneId, weztermTabId) => {
  console.log('[helm] navigate:', { sessionName, windowName, paneId, weztermTabId });
  if (weztermTabId) {
    const r = await runFile(weztermBinMain, ['cli', 'activate-tab', '--tab-id', String(weztermTabId)]);
    if (r.error) console.log('[helm] wezterm activate-tab failed (non-fatal):', r.error.message);
  }
  if (sessionName && windowName) {
    const r = await runFile('tmux', ['select-window', '-t', `${sessionName}:${windowName}`]);
    if (r.error) console.log('[helm] tmux select-window:', r.error.message);
  }
  if (paneId) {
    const r = await runFile('tmux', ['select-pane', '-t', String(paneId)]);
    if (r.error) console.log('[helm] tmux select-pane:', r.error.message);
  }
});

ipcMain.on('save-front-order', (_event, order) => {
  if (!Array.isArray(order)) return;
  const orderFile = path.join(os.homedir(), '.helm', 'front-order.json');
  try { fs.writeFileSync(orderFile, JSON.stringify(order, null, 2), 'utf8'); } catch (e) { console.error('save-front-order:', e.message); }
});

ipcMain.on('set-ignore-mouse', (_event, ignore) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.on('confirm-name', (_event, sessionName, name) => {
  if (!sessionName || !name) return;
  saveSessionName(sessionName, String(name).trim());
  // Mark as confirmed so aiSuggested badge disappears
  const confirmedFile = path.join(os.homedir(), '.helm', 'confirmed-names.json');
  try {
    const c = fs.existsSync(confirmedFile) ? JSON.parse(fs.readFileSync(confirmedFile, 'utf8') || '{}') : {};
    c[sessionName] = true;
    fs.writeFileSync(confirmedFile, JSON.stringify(c, null, 2), 'utf8');
  } catch (e) { console.error('confirm-name write:', e.message); }
});

ipcMain.handle('get-state', async () => latestState);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (daemonSocket) {
    try { daemonSocket.terminate(); } catch {}
  }
});

app.on('window-all-closed', () => app.quit());

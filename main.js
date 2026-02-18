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

function runFile(file, args = []) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 4000 }, (error, stdout, stderr) => {
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
  const x = Math.round(primaryDisplay.workArea.x + (primaryDisplay.workArea.width - 660) / 2);

  win = new BrowserWindow({
    width: 660,
    height: 52,
    x,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
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
  const width = 660;
  const primaryDisplay = screen.getPrimaryDisplay();
  const x = Math.round(primaryDisplay.workArea.x + (primaryDisplay.workArea.width - width) / 2);
  const h = Math.max(52, Number(height) || 52);
  win.setBounds({ x, y: 0, width, height: h });
});

ipcMain.on('navigate-to-pane', async (_event, sessionName, windowName, paneId, weztermTabId) => {
  if (weztermTabId) await runFile('wezterm', ['cli', 'activate-tab', '--tab-id', String(weztermTabId)]);
  if (sessionName && windowName) await runFile('tmux', ['select-window', '-t', `${sessionName}:${windowName}`]);
  if (paneId) await runFile('tmux', ['select-pane', '-t', String(paneId)]);
});

ipcMain.on('confirm-name', (_event, sessionName, name) => {
  if (!sessionName || !name) return;
  saveSessionName(sessionName, String(name).trim());
});

ipcMain.handle('get-state', async () => latestState);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (daemonSocket) {
    try { daemonSocket.terminate(); } catch {}
  }
});

app.on('window-all-closed', () => app.quit());

const { spawn, execFile } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

const cwd = __dirname;
const electronApp = path.join(cwd, 'node_modules', 'electron', 'dist', 'Electron.app');

// ── Child process management ─────────────────────────────────────────────

let daemonProc = null;
let shuttingDown = false;

function spawnDaemon() {
  daemonProc = spawn(process.execPath, [path.join(cwd, 'daemon.js')], { cwd, stdio: 'inherit' });
  daemonProc.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`[helm] daemon exited (${code})`);
  });
}

function launchElectron() {
  // Use macOS `open` to launch Electron as a proper GUI app.
  // This works under launchd (spawn doesn't because launchd lacks GUI context).
  execFile('open', ['-n', electronApp, '--args', cwd], (err) => {
    if (err) console.error('[helm] failed to launch Electron:', err.message);
  });
}

function restartDaemon() {
  console.log('[helm] restarting daemon...');
  if (daemonProc && !daemonProc.killed) {
    daemonProc.once('exit', () => { spawnDaemon(); waitForPort(7373, 3000); });
    daemonProc.kill('SIGTERM');
  } else {
    spawnDaemon();
  }
}

function restartElectron() {
  console.log('[helm] restarting electron...');
  // Kill existing Electron instances for this app, then relaunch
  execFile('pkill', ['-f', 'Electron.app.*helm'], () => {
    setTimeout(launchElectron, 500);
  });
}

// ── File watcher (live reload) ───────────────────────────────────────────
// fs.watchFile uses stat polling — survives inode replacement (atomic writes from editors).

function watchFiles() {
  const opts = { interval: 1000 };
  fs.watchFile(path.join(cwd, 'daemon.js'), opts, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) restartDaemon();
  });
  fs.watchFile(path.join(cwd, 'main.js'), opts, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) restartElectron();
  });
  fs.watchFile(path.join(cwd, 'preload.js'), opts, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) restartElectron();
  });
}

// ── Wait for port ────────────────────────────────────────────────────────

function waitForPort(port, maxMs = 5000) {
  const start = Date.now();
  return new Promise((resolve) => {
    function attempt() {
      if (Date.now() - start > maxMs) return resolve(false);
      const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => setTimeout(attempt, 150));
    }
    attempt();
  });
}

// ── Guard: single instance ────────────────────────────────────────────────

function isPortInUse(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
  });
}

// ── Bootstrap ────────────────────────────────────────────────────────────

isPortInUse(7373).then((inUse) => {
  if (inUse) {
    console.log('[helm] another instance already running (port 7373 in use), exiting.');
    process.exit(0);
  }

  spawnDaemon();

  waitForPort(7373).then((ok) => {
    if (!ok) console.warn('[helm] daemon not ready after 5s, starting Electron anyway');
    launchElectron();
    watchFiles();
  });
});

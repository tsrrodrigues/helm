const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const cwd = __dirname;

const daemon = spawn(process.execPath, [path.join(cwd, 'daemon.js')], {
  cwd,
  stdio: 'inherit'
});

daemon.on('exit', (code) => {
  console.log(`daemon exited (${code})`);
  process.exit(code || 0);
});

// Wait for daemon WebSocket to be ready before launching Electron
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

waitForPort(7373).then((ok) => {
  if (!ok) console.warn('[helm] daemon not ready after 5s, starting Electron anyway');

  const electronBin = process.platform === 'win32'
    ? path.join(cwd, 'node_modules', '.bin', 'electron.cmd')
    : path.join(cwd, 'node_modules', '.bin', 'electron');

  const app = spawn(electronBin, ['.'], { cwd, stdio: 'inherit' });
  app.on('exit', (code) => {
    if (!daemon.killed) daemon.kill('SIGTERM');
    process.exit(code || 0);
  });
});

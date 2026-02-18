const { spawn } = require('child_process');
const path = require('path');

const cwd = __dirname;

const daemon = spawn(process.execPath, [path.join(cwd, 'daemon.js')], {
  cwd,
  stdio: 'inherit'
});

daemon.on('exit', (code) => {
  console.log(`daemon exited (${code})`);
});

setTimeout(() => {
  const electronBin = process.platform === 'win32'
    ? path.join(cwd, 'node_modules', '.bin', 'electron.cmd')
    : path.join(cwd, 'node_modules', '.bin', 'electron');

  const app = spawn(electronBin, ['.'], { cwd, stdio: 'inherit' });
  app.on('exit', (code) => {
    if (!daemon.killed) daemon.kill('SIGTERM');
    process.exit(code || 0);
  });
}, 700);

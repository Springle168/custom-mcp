import { spawn } from 'node:child_process';

// Both processes have independent lifetimes if the privileged assertion fails.
setTimeout(() => process.exit(94), 15_000);
const descendant = spawn(
  process.execPath,
  ['-e', 'setTimeout(() => process.exit(95), 12000); setInterval(() => {}, 1000);'],
  { stdio: ['ignore', process.stdout, process.stderr], windowsHide: true },
);
console.log(`runner descendant PID: ${descendant.pid}`);
setInterval(() => {}, 1_000);

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const descendantScript = fileURLToPath(new URL('./hold-inherited-stdio.ts', import.meta.url));
const descendant = spawn(process.execPath, ['--import', 'tsx', descendantScript], {
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});

descendant.unref();
descendant.once('message', () => {
  process.exit(0);
});
descendant.once('error', () => {
  process.exit(2);
});

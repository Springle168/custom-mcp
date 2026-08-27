import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';

const READY_PORT_PREFIX = '--ready-port=';

function parseReadyPort(args: readonly string[]): number | undefined {
  if (args.length === 0) {
    return undefined;
  }

  if (args.length !== 1 || !args[0]?.startsWith(READY_PORT_PREFIX)) {
    throw new Error(`Expected at most one ${READY_PORT_PREFIX}<port> argument.`);
  }

  const rawPort = args[0].slice(READY_PORT_PREFIX.length);
  if (!/^\d+$/u.test(rawPort)) {
    throw new Error('Readiness port must be a decimal integer.');
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Readiness port must be between 1 and 65535.');
  }

  return port;
}

let readyPort: number | undefined;
try {
  readyPort = parseReadyPort(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
}

const descendantScript = fileURLToPath(new URL('./hold-inherited-stdio.ts', import.meta.url));
const descendant = spawn(process.execPath, ['--import', 'tsx', descendantScript], {
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});

descendant.unref();
descendant.once('message', () => {
  if (readyPort === undefined) {
    process.exit(0);
  }

  const socket = net.createConnection({
    host: '127.0.0.1',
    port: readyPort,
  });
  socket.once('error', () => {
    process.exit(4);
  });
  socket.end('ready\n', () => {
    process.exit(0);
  });
});
descendant.once('error', () => {
  process.exit(2);
});

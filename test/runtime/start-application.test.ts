import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConfigError } from '../../src/config.js';
import { startApplication } from '../../src/runtime/application/start-application.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
  writeSplitConfigFixture,
} from '../test-utils.js';

const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
const FIXTURES_DIR = path.join(FIXTURES_ROOT, 'start-application');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const ROOT_DIR = path.join(FIXTURES_DIR, 'workspace');
const CONFIG_FILE = path.join(HOME_DIR, '.custom-mcp', 'config.json');
const LOGS_DIR = path.join(HOME_DIR, '.custom-mcp', 'logs');

async function prepareFixtures(): Promise<void> {
  await fs.mkdir(ROOT_DIR, { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  assertEqual(
    path.dirname(path.resolve(FIXTURES_DIR)),
    path.resolve(FIXTURES_ROOT),
    'Fixture cleanup must stay inside test/fixtures',
  );
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert(address !== null && typeof address !== 'string', 'Port probe should bind a loopback port');
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function testApplicationComposesSelectedServiceAndClosesResources(): Promise<void> {
  const port = await availablePort();
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [
      {
        id: 'selected',
        rootDir: ROOT_DIR,
        host: '127.0.0.1',
        port,
        lineEnding: 'auto',
        tools: { enabled: ['read'] },
      },
    ],
  });
  const signalCounts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const application = startApplication({ homeDir: HOME_DIR, workspaceId: 'selected', env: {} });
  const first = new Client({ name: 'application-first', version: '1.0.0' });
  const second = new Client({ name: 'application-second', version: '1.0.0' });
  let closed = false;
  try {
    await once(application.listener, 'listening');
    assertEqual(application.listener.listening, true, 'Application should start its listener');
    assertEqual(
      process.listenerCount('SIGINT'),
      signalCounts[0],
      'Application composition must not install SIGINT handlers',
    );
    assertEqual(
      process.listenerCount('SIGTERM'),
      signalCounts[1],
      'Application composition must not install SIGTERM handlers',
    );
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    await first.connect(new StreamableHTTPClientTransport(url));
    await second.connect(new StreamableHTTPClientTransport(url));
    for (const client of [first, second]) {
      const listed = await client.listTools();
      assertEqual(
        listed.tools.map((tool) => tool.name).join(','),
        'read',
        'Selected exposure must be shared by every session',
      );
      const hidden = await client.callTool({ name: 'write_file', arguments: {} });
      assertEqual(
        hidden.isError,
        true,
        'Hidden tools should remain unavailable through the application',
      );
      assertIncludes(
        JSON.stringify(hidden.content),
        'Unknown tool',
        'Hidden tool should use the exposure error',
      );
    }

    const closing = application.close('SIGTERM');
    assertEqual(
      application.close(),
      closing,
      'Repeated application close should share lifecycle work',
    );
    await closing;
    closed = true;
    assertEqual(
      application.listener.listening,
      false,
      'Application close should stop the listener',
    );

    const logFiles = await fs.readdir(LOGS_DIR, { recursive: true });
    const logFile = logFiles.find((file) => file.endsWith('.log'));
    assert(logFile !== undefined, 'Application should create a workspace log file');
    const log = await fs.readFile(path.join(LOGS_DIR, logFile), 'utf8');
    assertIncludes(
      log,
      'MCP Replace Server started',
      'Listener readiness should emit the startup summary',
    );
    assertIncludes(
      log,
      'Workspace id: selected',
      'Startup summary should identify the selected workspace',
    );
    assertIncludes(
      log,
      'Received SIGTERM; starting graceful shutdown.',
      'Signal shutdown logging should be preserved',
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
    if (!closed) await application.close();
  }
}

function testInvalidSelectionFailsBeforeListening(): void {
  let failure: unknown;
  try {
    startApplication({ homeDir: HOME_DIR, workspaceId: 'missing', env: {} });
  } catch (error: unknown) {
    failure = error;
  }
  assert(
    failure instanceof ConfigError,
    'Invalid selection should propagate the startup config error',
  );
  assertIncludes(
    failure.message,
    'missing',
    'Startup failure should retain workspace selection details',
  );
}

await runTestSuite({
  title: 'Testing application composition and startup',
  beforeAll: prepareFixtures,
  afterAll: cleanupFixtures,
  tests: [
    {
      name: 'application composes selected service and closes resources',
      run: testApplicationComposesSelectedServiceAndClosesResources,
    },
    {
      name: 'invalid selection fails before listening',
      run: testInvalidSelectionFailsBeforeListening,
    },
  ],
});

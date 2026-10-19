import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CallToolResultSchema,
  InitializeResultSchema,
  JSONRPCResponseSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { startApplication } from '../../src/runtime/application/start-application.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
  writeSplitConfigFixture,
} from '../test-utils.js';

const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
const FIXTURES_DIR = path.join(FIXTURES_ROOT, 'request-header-start-application');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const ROOT_DIR = path.join(FIXTURES_DIR, 'workspace');
const CONFIG_FILE = path.join(HOME_DIR, '.custom-mcp', 'config.json');
const LOGS_DIR = path.join(HOME_DIR, '.custom-mcp', 'logs');
const INSTRUCTIONS = 'private-session-instructions-sentinel';

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert(address !== null && typeof address !== 'string', 'Probe must bind loopback');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    message:
      text.trim() === ''
        ? undefined
        : (JSON.parse(data === undefined ? text : data.slice(6)) as unknown),
  };
}

function responseResult(message: unknown) {
  const response = JSONRPCResponseSchema.parse(message);
  assert('result' in response, 'Expected successful JSON-RPC result envelope');
  return response.result;
}

async function testProductionCompositionInstallsBothStages(): Promise<void> {
  const port = await availablePort();
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [
      {
        id: 'header-stages',
        rootDir: ROOT_DIR,
        host: '127.0.0.1',
        port,
        lineEnding: 'auto',
        tools: { enabled: ['read', 'write_file'] },
        rules: {
          requestHeaders: {
            onInitialize: [
              { readHeader: 'x-session-tools', apply: 'setToolList' },
              { readHeader: 'x-session-instructions', apply: 'setInstructions' },
            ],
            onCallToolResult: [
              {
                match: { 'x-result-client': 'private-match-sentinel' },
                enable: ['structuredContentDup'],
              },
            ],
          },
        },
      },
    ],
  });
  const application = startApplication({
    homeDir: HOME_DIR,
    workspaceId: 'header-stages',
    env: {},
  });
  try {
    await once(application.listener, 'listening');
    const url = `http://127.0.0.1:${port}/mcp`;
    const initialized = await post(
      url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'production-header-test', version: '1' },
        },
      },
      {
        'x-session-tools': JSON.stringify({
          toolList: ['read', 'private-unexposed-tool-sentinel'],
        }),
        'x-session-instructions': JSON.stringify({ instructions: INSTRUCTIONS }),
      },
    );
    assertEqual(initialized.status, 200, 'Production initialize should succeed');
    assert(initialized.sessionId !== null, 'Production composition must return a session ID');
    const initResult = InitializeResultSchema.parse(responseResult(initialized.message));
    assertEqual(
      initResult.instructions,
      INSTRUCTIONS,
      'Production initialization extension must install instructions',
    );
    const sessionHeaders = {
      'mcp-session-id': initialized.sessionId,
      'mcp-protocol-version': initResult.protocolVersion,
    };
    const notification = await post(
      url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionHeaders,
    );
    assertEqual(notification.status, 202, 'Initialized notification should be accepted');
    const list = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionHeaders);
    const tools = ListToolsResultSchema.parse(responseResult(list.message)).tools;
    assertEqual(
      tools.map((tool) => tool.name).join(','),
      'read',
      'Production prepare hook must restrict session view',
    );

    for (const [id, name, args] of [
      [3, 'read', { include: [path.join(ROOT_DIR, 'sample.txt')] }],
      [4, 'write_file', { file_path: 'sample.txt', content: 'not admitted' }],
      [5, 'read', {}],
    ] as const) {
      const called = await post(
        url,
        { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
        {
          ...sessionHeaders,
          'x-result-client': 'private-match-sentinel',
        },
      );
      assertEqual(called.status, 200, 'Tool result should use normal transport response');
      const result = CallToolResultSchema.parse(responseResult(called.message));
      assert(
        result.structuredContent !== undefined,
        'Production result hook must adapt success and controlled errors',
      );
      assertEqual(
        result.isError === true,
        id !== 3,
        'Original success/error state must survive adaptation',
      );
      assertEqual(
        JSON.stringify(result.structuredContent.content),
        JSON.stringify(result.content),
        'Captured adapter must duplicate canonical content',
      );
      if (id === 4)
        assertIncludes(
          JSON.stringify(result.content),
          'Unknown tool: write_file',
          'Session restriction must apply to calls',
        );
    }

    // Existing-session POST must not interpret damaged initialization parameters.
    const plain = await post(
      url,
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'read',
          arguments: { include: [path.join(ROOT_DIR, 'sample.txt')] },
        },
      },
      { ...sessionHeaders, 'x-session-tools': '{broken' },
    );
    const plainResult = CallToolResultSchema.parse(responseResult(plain.message));
    assertEqual(
      plainResult.structuredContent,
      undefined,
      'Unmatched later call must not inherit initialization or previous call policy',
    );
  } finally {
    await application.close();
  }
  const logFiles = (await fs.readdir(LOGS_DIR, { recursive: true })).filter((file) =>
    file.endsWith('.log'),
  );
  assertEqual(logFiles.length, 1, 'Production test should create one log');
  const log = await fs.readFile(path.join(LOGS_DIR, logFiles[0]!), 'utf8');
  assertIncludes(log, 'Session policy:', 'Production initialization summary must be logged');
  assert(
    log.indexOf('New session:') < log.indexOf('Session policy:'),
    'Core publication log must precede policy observation',
  );
  assertIncludes(
    log,
    'Rules: matched rules.requestHeaders.onCallToolResult[0]; enabled structuredContentDup',
    'Production result summary must be logged',
  );
  assertIncludes(log, 'Rules: no match', 'Unmatched call must retain configured-stage summary');
  for (const secret of [
    INSTRUCTIONS,
    'private-match-sentinel',
    'private-unexposed-tool-sentinel',
    'x-session-tools',
    'x-session-instructions',
    'x-result-client',
    '{broken',
  ]) {
    assertNotIncludes(log, secret, 'Policy inputs must not leak into production logs');
  }
}

await runTestSuite({
  title: 'Testing production request-header extension composition',
  beforeAll: async () => {
    await fs.mkdir(ROOT_DIR, { recursive: true });
    await fs.mkdir(LOGS_DIR, { recursive: true });
    await fs.writeFile(path.join(ROOT_DIR, 'sample.txt'), 'Production fixture.', 'utf8');
  },
  afterAll: async () => {
    assertEqual(
      path.dirname(path.resolve(FIXTURES_DIR)),
      path.resolve(FIXTURES_ROOT),
      'Cleanup must remain within fixture root',
    );
    await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  },
  tests: [
    {
      name: 'production composition installs initialization and result extensions',
      run: testProductionCompositionInstallsBothStages,
    },
  ],
});

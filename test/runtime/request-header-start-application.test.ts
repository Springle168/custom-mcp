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
  const application = await startApplication({
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

async function testAliasesThroughProductionSessionAndLogs(): Promise<void> {
  const port = await availablePort();
  const toolConfigFile = path.join(FIXTURES_DIR, 'alias-tools.json');
  const definitions = [
    {
      id: 'custom-reference',
      declaration: {
        name: 'custom_tool',
        $alias: 'custom_call',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    },
    {
      id: 'read-reference',
      declaration: { name: 'read', $alias: 'read_call', $inheritInputSchema: true },
    },
    {
      id: 'write-reference',
      declaration: {
        name: 'write_file',
        $alias: 'write_call',
        $inheritInputSchema: true,
        $inheritTopDescription: true,
      },
    },
  ];
  for (const { id, declaration } of definitions) {
    await fs.writeFile(path.join(FIXTURES_DIR, `${id}.json`), JSON.stringify(declaration), 'utf8');
  }
  await fs.writeFile(
    toolConfigFile,
    JSON.stringify({
      version: 2,
      definitions: definitions.map(({ id }) => ({
        id,
        toolDefinitionFile: path.join(FIXTURES_DIR, `${id}.json`),
      })),
    }),
    'utf8',
  );
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [
      {
        id: 'alias-session',
        rootDir: ROOT_DIR,
        host: '127.0.0.1',
        port,
        lineEnding: 'auto',
        tools: { toolConfigFile, enabled: ['custom_tool', 'write_file', 'read'] },
        rules: {
          requestHeaders: {
            onInitialize: [{ readHeader: 'x-session-tools', apply: 'setToolList' }],
          },
        },
      },
    ],
  });
  const application = await startApplication({
    homeDir: HOME_DIR,
    workspaceId: 'alias-session',
    env: {},
  });
  try {
    await once(application.listener, 'listening');
    const url = `http://127.0.0.1:${port}/mcp`;
    async function session(toolList: string[], id: number) {
      const initialized = await post(
        url,
        {
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'alias-session-test', version: '1' },
          },
        },
        { 'x-session-tools': JSON.stringify({ toolList }) },
      );
      assertEqual(initialized.status, 200, 'Alias session initialize must succeed');
      assert(initialized.sessionId !== null, 'Alias session must receive a session ID');
      const result = InitializeResultSchema.parse(responseResult(initialized.message));
      const headers = {
        'mcp-session-id': initialized.sessionId,
        'mcp-protocol-version': result.protocolVersion,
      };
      const notification = await post(
        url,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        headers,
      );
      assertEqual(notification.status, 202, 'Alias session must complete initialization');
      return headers;
    }

    const headers = await session(
      ['custom_call', 'read', 'custom_tool', 'read_call', 'write_file', 'unknown_call'],
      101,
    );
    const listed = await post(url, { jsonrpc: '2.0', id: 102, method: 'tools/list' }, headers);
    const tools = ListToolsResultSchema.parse(responseResult(listed.message)).tools;
    assertEqual(
      tools.map((tool) => tool.name).join(','),
      'read_call,custom_call',
      'setToolList must use public names and retain catalog order rather than selector order',
    );
    for (const tool of tools) {
      assert(!('description' in tool), 'Omitted descriptions must remain absent on the wire');
      for (const directive of ['$alias', '$inheritInputSchema', '$inheritTopDescription']) {
        assert(!(directive in tool), 'Source directives must not escape into MCP definitions');
      }
    }
    const rawList = responseResult(listed.message);
    assert(
      typeof rawList === 'object' &&
        rawList !== null &&
        'tools' in rawList &&
        Array.isArray(rawList.tools),
      'Raw MCP list must contain tool definitions',
    );
    for (const tool of rawList.tools) {
      assert(
        typeof tool === 'object' && tool !== null && !('description' in tool),
        'Raw MCP tools must omit top-level descriptions without removing schema descriptions',
      );
    }

    const calls = [
      { name: 'read_call', arguments: { include: [path.join(ROOT_DIR, 'sample.txt')] }, ok: true },
      { name: 'custom_call', arguments: { value: 'accepted' }, error: 'no execution route' },
      { name: 'custom_call', arguments: {}, error: 'custom_call' },
      { name: 'read', arguments: {}, error: 'Unknown tool: read' },
      { name: 'custom_tool', arguments: {}, error: 'Unknown tool: custom_tool' },
      { name: 'write_call', arguments: {}, error: 'Unknown tool: write_call' },
    ];
    for (const [index, call] of calls.entries()) {
      const reply = await post(
        url,
        {
          jsonrpc: '2.0',
          id: 110 + index,
          method: 'tools/call',
          params: { name: call.name, arguments: call.arguments },
        },
        headers,
      );
      assertEqual(reply.status, 200, 'Alias calls must retain the normal MCP result envelope');
      const result = CallToolResultSchema.parse(responseResult(reply.message));
      assertEqual(result.isError === true, !call.ok, 'Alias calls must keep execution/error state');
      if (call.error !== undefined) {
        assertIncludes(JSON.stringify(result.content), call.error, 'Errors must use public names');
      } else {
        assertIncludes(
          JSON.stringify(result.content),
          'Production fixture.',
          'Built-in alias must execute the original read implementation',
        );
      }
      for (const secret of ['read-reference', 'custom-reference', toolConfigFile]) {
        assertNotIncludes(JSON.stringify(result), secret, 'Tool results must not reveal sources');
      }
    }

    const stableOnlyHeaders = await session(['read', 'custom_tool', 'write_file'], 120);
    const stableOnly = await post(
      url,
      { jsonrpc: '2.0', id: 121, method: 'tools/list' },
      stableOnlyHeaders,
    );
    assertEqual(
      ListToolsResultSchema.parse(responseResult(stableOnly.message)).tools.length,
      0,
      'Stable names must not act as compatibility session selectors',
    );
  } finally {
    await application.close();
  }

  const logs = await fs.readdir(LOGS_DIR, { recursive: true });
  const log = (
    await Promise.all(
      logs
        .filter((file) => file.endsWith('.log'))
        .map((file) => fs.readFile(path.join(LOGS_DIR, file), 'utf8')),
    )
  ).join('\n');
  assertIncludes(log, '← CALL read_call\n', 'CALL main log must use the requested built-in alias');
  assertIncludes(log, '→ OK read_call ', 'RESULT main log must use the requested built-in alias');
  assertIncludes(log, '← CALL custom_call\n', 'CALL main log must use the custom-only alias');
  assertIncludes(log, '→ FAIL custom_call ', 'RESULT main log must use the custom-only alias');
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
    {
      name: 'aliases preserve production MCP session selection, omission and main log names',
      run: testAliasesThroughProductionSessionAndLogs,
    },
  ],
});

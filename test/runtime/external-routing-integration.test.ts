import * as fs from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { createConfigStore } from '../../src/runtime/config-store.js';
import { createMCPServer } from '../../src/runtime/mcp-server.js';
import { runWithRequestHeaderContext } from '../../src/runtime/request-context.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request-header-view.js';
import {
  loadApplicationRuntime,
  type LoadedApplicationRuntime,
} from '../../src/runtime/startup-runtime.js';
import {
  parseCanonicalRequestDocument,
  type CanonicalContentBlock,
  type CanonicalRequest,
} from '../../src/tools/external-routing/canonical-protocol.js';
import { createWorkspaceToolService } from '../../src/tools/index.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
  writeSplitConfigFixture,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'external-routing-integration');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const ROOT_DIR = path.join(FIXTURES_DIR, 'workspace');
const TOOL_CONFIG_FILE = path.join(FIXTURES_DIR, 'tool-config.json');
const FIRST_TOOL_DEFINITION_FILE = path.join(FIXTURES_DIR, 'external-custom-tool.json');
const SECOND_TOOL_DEFINITION_FILE = path.join(FIXTURES_DIR, 'second-external-custom-tool.json');
const EXTERNAL_ROUTING_CONFIG_FILE = path.join(FIXTURES_DIR, 'external-routing-config.json');
const FIRST_ENDPOINT_CONFIG_FILE = path.join(FIXTURES_DIR, 'endpoint-config.json');
const SECOND_ENDPOINT_CONFIG_FILE = path.join(FIXTURES_DIR, 'second-endpoint-config.json');
const MCP_SERVER_CONFIG_FILE = path.join(FIXTURES_DIR, 'mcp-server-config.json');
const FIRST_TOOL_NAME = 'external_custom_tool';
const SECOND_TOOL_NAME = 'second_external_custom_tool';
const FIRST_COMPLETED_MESSAGE = 'First loopback endpoint completed the custom tool.';
const SECOND_COMPLETED_MESSAGE = 'Second loopback endpoint completed the custom tool.';

interface CapturedEndpointCall {
  readonly method: string;
  readonly request: CanonicalRequest;
}

interface LoopbackEndpoint {
  readonly baseUrl: string;
  readonly calls: readonly CapturedEndpointCall[];
  readonly failures: readonly unknown[];
  requestCount(): number;
  close(): Promise<void>;
}

interface ConnectedMcpPair {
  readonly client: Client;
  readonly server: McpServer;
}

interface DownstreamMcpServer {
  readonly url: string;
  readonly calls: readonly Record<string, unknown>[];
  initializeCount(): number;
  listCount(): number;
  close(): Promise<void>;
}

function getTextContent(result: unknown): string {
  if (
    typeof result !== 'object'
    || result === null
    || !('content' in result)
    || !Array.isArray(result.content)
  ) {
    return '';
  }

  const first = result.content[0];
  if (typeof first !== 'object' || first === null || !('text' in first)) {
    return '';
  }
  return typeof first.text === 'string' ? first.text : '';
}

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await Promise.all([
    fs.mkdir(LOGS_DIR, { recursive: true }),
    fs.mkdir(ROOT_DIR, { recursive: true }),
  ]);
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeExternalRoutingFixture(
  firstEndpointUrl: string,
  secondEndpointUrl: string,
  structuredContentDup = false,
): Promise<void> {
  const inputSchema = {
    type: 'object',
    properties: {
      value: { type: 'string' },
    },
    required: ['value'],
    additionalProperties: false,
  };
  await Promise.all([
    fs.writeFile(FIRST_TOOL_DEFINITION_FILE, JSON.stringify({
      name: FIRST_TOOL_NAME,
      description: 'Routes the first custom-only test tool.',
      inputSchema,
    }, null, 2), 'utf-8'),
    fs.writeFile(SECOND_TOOL_DEFINITION_FILE, JSON.stringify({
      name: SECOND_TOOL_NAME,
      description: 'Routes the second custom-only test tool.',
      inputSchema,
    }, null, 2), 'utf-8'),
    fs.writeFile(FIRST_ENDPOINT_CONFIG_FILE, JSON.stringify({
      version: 1,
      url: firstEndpointUrl,
      timeoutMs: 1_000,
      headers: {},
    }, null, 2), 'utf-8'),
    fs.writeFile(SECOND_ENDPOINT_CONFIG_FILE, JSON.stringify({
      version: 1,
      url: secondEndpointUrl,
      timeoutMs: 1_000,
      headers: {},
    }, null, 2), 'utf-8'),
  ]);
  await fs.writeFile(EXTERNAL_ROUTING_CONFIG_FILE, JSON.stringify({
    version: 2,
    routes: [
      {
        definitionId: 'external-custom-tool',
        routingMode: 'http',
        httpEndpointConfigFile: FIRST_ENDPOINT_CONFIG_FILE,
        routingStrategy: {
          'request-to-external': [{ mode: 'direct' }],
          'response-from-external': [{ mode: 'direct' }],
        },
      },
      {
        definitionId: 'second-external-custom-tool',
        routingMode: 'http',
        httpEndpointConfigFile: SECOND_ENDPOINT_CONFIG_FILE,
        routingStrategy: {
          'request-to-external': [{ mode: 'direct' }],
          'response-from-external': [{ mode: 'direct' }],
        },
      },
    ],
  }, null, 2), 'utf-8');
  await fs.writeFile(TOOL_CONFIG_FILE, JSON.stringify({
    version: 2,
    definitions: [
      {
        id: 'external-custom-tool',
        toolDefinitionFile: FIRST_TOOL_DEFINITION_FILE,
      },
      {
        id: 'second-external-custom-tool',
        toolDefinitionFile: SECOND_TOOL_DEFINITION_FILE,
      },
    ],
    externalRoutingConfigFile: EXTERNAL_ROUTING_CONFIG_FILE,
  }, null, 2), 'utf-8');
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [{
      id: 'selected',
      rootDir: ROOT_DIR,
      host: '127.0.0.1',
      port: 4914,
      lineEnding: 'auto',
      logsDir: LOGS_DIR,
      ...(structuredContentDup ? {
        rules: {
          requestHeaders: [{
            match: { 'x-client': 'canonical-content-test' },
            enable: ['structuredContentDup'],
          }],
        },
      } : {}),
      tools: {
        toolConfigFile: TOOL_CONFIG_FILE,
        enabled: [FIRST_TOOL_NAME, SECOND_TOOL_NAME],
      },
    }],
  });
}

async function startLoopbackEndpoint(
  completedMessage: string,
  responseFor?: (request: CanonicalRequest) => unknown,
): Promise<LoopbackEndpoint> {
  const calls: CapturedEndpointCall[] = [];
  const failures: unknown[] = [];
  const sockets = new Set<Socket>();
  let requestCount = 0;

  const server = createServer((request, response) => {
    requestCount++;
    handleEndpointRequest(request, response, calls, failures, completedMessage, responseFor);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  assert(address !== null && typeof address !== 'string', 'Loopback endpoint should expose a TCP port.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    failures,
    requestCount: () => requestCount,
    close: () => closeHttpServer(server, sockets),
  };
}

function handleEndpointRequest(
  request: IncomingMessage,
  response: ServerResponse,
  calls: CapturedEndpointCall[],
  failures: unknown[],
  completedMessage: string,
  responseFor?: (request: CanonicalRequest) => unknown,
): void {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.once('error', (error) => failures.push(error));
  request.once('end', () => {
    try {
      const canonicalRequest = parseCanonicalRequestDocument(Buffer.concat(chunks));
      calls.push({
        method: request.method ?? '',
        request: canonicalRequest,
      });
      const call = canonicalRequest.calls[0];
      const body = JSON.stringify(responseFor?.(canonicalRequest) ?? {
        results: [{
          id: call.id,
          status: 'completed',
          content: [{ type: 'text', text: completedMessage }],
        }],
      });
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(body)),
      });
      response.end(body);
    } catch (error: unknown) {
      failures.push(error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid canonical request.');
    }
  });
}

async function startDownstreamMcpServer(): Promise<DownstreamMcpServer> {
  const calls: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  let initializeCount = 0;
  let listCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(200).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (message.method === 'initialize') {
      initializeCount++;
      writeDownstreamJson(response, message.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'downstream-integration', version: '1' },
      }, { 'Mcp-Session-Id': 'shared-downstream-session' });
      return;
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    }
    if (message.method === 'tools/list') {
      listCount++;
      writeDownstreamJson(response, message.id, { tools: [] });
      return;
    }
    if (message.method === 'tools/call') {
      calls.push(message);
      const params = message.params as Record<string, unknown>;
      writeDownstreamJson(response, message.id, {
        content: [{ type: 'text', text: `downstream:${String(params.name)}` }],
      });
      return;
    }
    response.writeHead(400).end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address !== null && typeof address !== 'string', 'Downstream MCP server should expose a port.');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    initializeCount: () => initializeCount,
    listCount: () => listCount,
    close: () => closeHttpServer(server, sockets),
  };
}

function writeDownstreamJson(
  response: ServerResponse,
  id: unknown,
  result: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

async function closeHttpServer(
  server: HttpServer,
  sockets: ReadonlySet<Socket>,
): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function connectMcpServer(
  runtime: LoadedApplicationRuntime,
  options: {
    readonly rawHeaders?: readonly string[];
    readonly onResult?: (result: ToolCallResult) => void;
  } = {},
): Promise<ConnectedMcpPair> {
  const server = createMCPServer({
    configStore: createConfigStore(runtime),
    logger: {
      logToolCall() {},
      logToolResult(_name, result) { options.onResult?.(result); },
    },
    toolService: createWorkspaceToolService(runtime.toolCatalog),
  });
  const client = new Client({ name: 'external-routing-integration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  if (options.rawHeaders !== undefined) {
    // Model the HTTP listener's request-scoped header context at the server boundary.
    const onmessage = serverTransport.onmessage;
    const headerView = createStrictRequestHeaderView([...options.rawHeaders]);
    serverTransport.onmessage = (message, extra) =>
      runWithRequestHeaderContext(headerView, () => onmessage?.(message, extra));
  }
  return { client, server };
}

async function testCanonicalContentThroughMcpAndPolicy(): Promise<void> {
  // Arbitrary bytes are intentional: this fixture verifies base64, not image structure.
  const content: readonly CanonicalContentBlock[] = [
    { type: 'text', text: 'Preview:' },
    { type: 'image', data: 'AQID', mime_type: 'image/png' },
    { type: 'unknown', value: { type: 'image', details: [null, false, 0, ''] } },
    { type: 'text', text: '' },
    { type: 'text', text: 'adjacent' },
    { type: 'unknown', value: null },
    { type: 'unknown', value: false },
    { type: 'unknown', value: 0 },
    { type: 'unknown', value: '' },
  ];
  const expectedContent = [
    { type: 'text', text: 'Preview:' },
    { type: 'image', data: 'AQID', mimeType: 'image/png' },
    { type: 'text', text: '{"type":"image","details":[null,false,0,""]}' },
    { type: 'text', text: '' },
    { type: 'text', text: 'adjacent' },
    { type: 'text', text: 'null' },
    { type: 'text', text: 'false' },
    { type: 'text', text: '0' },
    { type: 'text', text: '""' },
  ];

  for (const duplicate of [false, true]) {
    const endpoint = await startLoopbackEndpoint('', (request) => {
      const value = request.calls[0].arguments.value;
      return {
        results: [{
          id: request.calls[0].id,
          status: typeof value === 'string' ? value.split(':')[0] : 'completed',
          content: typeof value === 'string' && value.endsWith(':empty') ? [] : content,
        }],
      };
    });
    let runtime: LoadedApplicationRuntime | undefined;
    let pair: ConnectedMcpPair | undefined;
    const logged: ToolCallResult[] = [];
    try {
      await writeExternalRoutingFixture(endpoint.baseUrl, endpoint.baseUrl, true);
      runtime = loadApplicationRuntime({ homeDir: HOME_DIR, workspaceId: 'selected', env: {} });
      pair = await connectMcpServer(runtime, {
        rawHeaders: ['X-Client', duplicate ? 'canonical-content-test' : 'unmatched-client'],
        onResult: (result) => logged.push(result),
      });
      for (const status of ['completed', 'failed', 'cancelled'] as const) {
        for (const empty of [false, true]) {
          const result = await pair.client.callTool({
            name: FIRST_TOOL_NAME,
            arguments: { value: `${status}:${empty ? 'empty' : 'mixed'}` },
          });
          const expected = empty ? [] : expectedContent;
          assertEqual(JSON.stringify(result.content), JSON.stringify(expected), 'MCP Client should receive the exact mapped block order and values');
          assertEqual(result.isError, status !== 'completed', 'MCP Client should receive the domain status without text prefixes');
          assert(!('_meta' in result), 'HTTP mapping must not introduce MCP metadata');
          const loggedResult = logged.at(-1);
          assert(loggedResult !== undefined, 'Validated results should reach the result logger');
          assertEqual(JSON.stringify(loggedResult.content), JSON.stringify(expected), 'Logger should receive mapped MCP blocks, not canonical unknown values');
          if (duplicate) {
            const expectedWrapper = { content: expected, isError: status !== 'completed' };
            assertEqual(JSON.stringify(result.structuredContent), JSON.stringify(expectedWrapper), 'Matched policy must duplicate only final MCP content and status');
            assertEqual(JSON.stringify(loggedResult.structuredContent), JSON.stringify(expectedWrapper), 'Logger should receive the same policy-adapted content');
          } else {
            assert(!('structuredContent' in result), 'Unmatched policy must not add structuredContent');
            assert(!('structuredContent' in loggedResult), 'Unmatched logger result must not acquire structuredContent');
          }
        }
      }
      assertEqual(endpoint.failures.length, 0, 'Canonical endpoint should receive valid requests throughout the MCP path');
      assertEqual(endpoint.requestCount(), 6, 'Each call should reach the endpoint once without retries');
    } finally {
      await cleanupRuntimeResources({ pair, runtime, endpoints: [endpoint] });
    }
  }
}

async function cleanupRuntimeResources(options: {
  readonly pair: ConnectedMcpPair | undefined;
  readonly runtime: LoadedApplicationRuntime | undefined;
  readonly endpoints: readonly LoopbackEndpoint[];
}): Promise<void> {
  const errors: unknown[] = [];
  if (options.pair !== undefined) {
    try {
      await options.pair.client.close();
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      await options.pair.server.close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (options.runtime !== undefined) {
    try {
      await options.runtime.close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  for (const endpoint of options.endpoints) {
    try {
      await endpoint.close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw errors[0];
  }
}

async function testMcpRoutesShareOneDownstreamSession(): Promise<void> {
  const downstream = await startDownstreamMcpServer();
  let runtime: LoadedApplicationRuntime | undefined;
  let pair: ConnectedMcpPair | undefined;
  try {
    const inputSchema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    };
    await Promise.all([
      fs.writeFile(FIRST_TOOL_DEFINITION_FILE, JSON.stringify({
        name: FIRST_TOOL_NAME,
        description: 'First MCP routed tool.',
        inputSchema,
      }), 'utf8'),
      fs.writeFile(SECOND_TOOL_DEFINITION_FILE, JSON.stringify({
        name: SECOND_TOOL_NAME,
        description: 'Second MCP routed tool.',
        inputSchema,
      }), 'utf8'),
      fs.writeFile(MCP_SERVER_CONFIG_FILE, JSON.stringify({
        version: 1,
        url: downstream.url,
        timeoutMs: 1_000,
      }), 'utf8'),
    ]);
    await fs.writeFile(EXTERNAL_ROUTING_CONFIG_FILE, JSON.stringify({
      version: 2,
      routes: [
        { definitionId: 'external-custom-tool', routingMode: 'mcp', mcpServerConfigFile: MCP_SERVER_CONFIG_FILE },
        { definitionId: 'second-external-custom-tool', routingMode: 'mcp', mcpServerConfigFile: MCP_SERVER_CONFIG_FILE },
      ],
    }), 'utf8');
    await fs.writeFile(TOOL_CONFIG_FILE, JSON.stringify({
      version: 2,
      definitions: [
        { id: 'external-custom-tool', toolDefinitionFile: FIRST_TOOL_DEFINITION_FILE },
        { id: 'second-external-custom-tool', toolDefinitionFile: SECOND_TOOL_DEFINITION_FILE },
      ],
      externalRoutingConfigFile: EXTERNAL_ROUTING_CONFIG_FILE,
    }), 'utf8');
    await writeSplitConfigFixture(CONFIG_FILE, {
      workspaces: [{
        id: 'selected',
        rootDir: ROOT_DIR,
        host: '127.0.0.1',
        port: 4914,
        lineEnding: 'auto',
        logsDir: LOGS_DIR,
        tools: { toolConfigFile: TOOL_CONFIG_FILE },
      }],
    });

    runtime = loadApplicationRuntime({ homeDir: HOME_DIR, workspaceId: 'selected', env: {} });
    await runtime.warmUp();
    pair = await connectMcpServer(runtime);
    const [first, second] = await Promise.all([
      pair.client.callTool({ name: FIRST_TOOL_NAME, arguments: { value: 'one' } }),
      pair.client.callTool({ name: SECOND_TOOL_NAME, arguments: { value: 'two' } }),
    ]);
    assertEqual(getTextContent(first), `downstream:${FIRST_TOOL_NAME}`, 'First route should preserve its local Tool name.');
    assertEqual(getTextContent(second), `downstream:${SECOND_TOOL_NAME}`, 'Second route should preserve its local Tool name.');
    assertEqual(downstream.initializeCount(), 1, 'Routes sharing one server config should share one downstream session.');
    assertEqual(downstream.listCount(), 0, 'External MCP routing must not call downstream tools/list.');
    assertEqual(downstream.calls.length, 2, 'Each upstream call should be sent downstream exactly once.');
  } finally {
    await cleanupRuntimeResources({ pair, runtime, endpoints: [] });
    await downstream.close();
  }
}

async function testExternalRoutingThroughRuntimeAndMcp(): Promise<void> {
  const [firstEndpoint, secondEndpoint] = await Promise.all([
    startLoopbackEndpoint(FIRST_COMPLETED_MESSAGE),
    startLoopbackEndpoint(SECOND_COMPLETED_MESSAGE),
  ]);
  let runtime: LoadedApplicationRuntime | undefined;
  let pair: ConnectedMcpPair | undefined;

  try {
    await writeExternalRoutingFixture(
      `${firstEndpoint.baseUrl}/canonical-tool`,
      `${secondEndpoint.baseUrl}/canonical-tool`,
    );
    runtime = loadApplicationRuntime({
      homeDir: HOME_DIR,
      workspaceId: 'selected',
      env: {},
    });
    pair = await connectMcpServer(runtime);

    const listed = await pair.client.listTools();
    assertEqual(listed.tools.length, 2, 'tools/list should expose both routed custom-only tools.');
    assertEqual(listed.tools[0]?.name, FIRST_TOOL_NAME, 'The first Tool should retain definition order.');
    assertEqual(listed.tools[1]?.name, SECOND_TOOL_NAME, 'The second Tool should retain definition order.');

    const invalid = await pair.client.callTool({
      name: FIRST_TOOL_NAME,
      arguments: {},
    });
    assertEqual(invalid.isError, true, 'Invalid custom arguments should return an MCP tool error.');
    assertIncludes(
      getTextContent(invalid),
      'configured input schema',
      'Invalid custom arguments should fail before external execution.',
    );
    assertEqual(firstEndpoint.requestCount(), 0, 'Invalid arguments must not request the first endpoint.');
    assertEqual(secondEndpoint.requestCount(), 0, 'Invalid arguments must not request the second endpoint.');

    const firstArguments = { value: 'first MCP call' };
    const firstCompleted = await pair.client.callTool({
      name: FIRST_TOOL_NAME,
      arguments: firstArguments,
    });
    assertEqual(firstCompleted.isError, false, 'The first route should return a successful MCP result.');
    assertEqual(getTextContent(firstCompleted), FIRST_COMPLETED_MESSAGE, 'The first route should use the first endpoint.');
    assertEqual(firstEndpoint.requestCount(), 1, 'The first route should request its endpoint exactly once.');
    assertEqual(secondEndpoint.requestCount(), 0, 'The first route must not request the second endpoint.');

    const secondArguments = { value: 'second MCP call' };
    const secondCompleted = await pair.client.callTool({
      name: SECOND_TOOL_NAME,
      arguments: secondArguments,
    });
    assertEqual(secondCompleted.isError, false, 'The second route should return a successful MCP result.');
    assertEqual(getTextContent(secondCompleted), SECOND_COMPLETED_MESSAGE, 'The second route should use the second endpoint.');
    assertEqual(firstEndpoint.requestCount(), 1, 'The second route must not request the first endpoint.');
    assertEqual(secondEndpoint.requestCount(), 1, 'The second route should request its endpoint exactly once.');

    for (const [endpoint, toolName, expectedArguments] of [
      [firstEndpoint, FIRST_TOOL_NAME, firstArguments],
      [secondEndpoint, SECOND_TOOL_NAME, secondArguments],
    ] as const) {
      assertEqual(endpoint.failures.length, 0, `${toolName} endpoint should receive valid canonical input.`);
      assertEqual(endpoint.calls.length, 1, `${toolName} endpoint should receive exactly one request.`);
      const captured = endpoint.calls[0];
      assert(captured !== undefined, `${toolName} call should be captured by its endpoint.`);
      assertEqual(captured.method, 'POST', 'External routing should use HTTP POST.');
      const canonicalCall = captured.request.calls[0];
      assertEqual(canonicalCall.name, toolName, 'Canonical request should use the Tool definition MCP name.');
      assertEqual(
        JSON.stringify(canonicalCall.arguments),
        JSON.stringify(expectedArguments),
        'Canonical request should preserve the matching MCP arguments.',
      );
      assert(
        /^call_[0-9a-f-]{36}$/i.test(canonicalCall.id),
        'Canonical request should use the MCP runtime generated call ID.',
      );
    }
  } finally {
    await cleanupRuntimeResources({
      pair,
      runtime,
      endpoints: [firstEndpoint, secondEndpoint],
    });
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external routing through startup runtime and MCP',
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'preserves canonical content through validation, policy, logger and MCP Client', run: testCanonicalContentThroughMcpAndPolicy },
      { name: 'routes two custom-only tools through independent loopback endpoints', run: testExternalRoutingThroughRuntimeAndMcp },
      { name: 'shares one downstream MCP session across two routes', run: testMcpRoutesShareOneDownstreamSession },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

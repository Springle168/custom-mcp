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
import {
  loadApplicationRuntime,
  type LoadedApplicationRuntime,
} from '../../src/runtime/startup-runtime.js';
import {
  parseCanonicalRequestDocument,
  type CanonicalRequest,
} from '../../src/tools/external-routing/canonical-protocol.js';
import { createWorkspaceToolService } from '../../src/tools/index.js';
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
const TOOL_DEFINITION_FILE = path.join(FIXTURES_DIR, 'external-custom-tool.json');
const PROCESSOR_CONFIG_FILE = path.join(FIXTURES_DIR, 'processor-config.json');
const ENDPOINT_CONFIG_FILE = path.join(FIXTURES_DIR, 'endpoint-config.json');
const EXTERNAL_TOOL_NAME = 'external_custom_tool';
const COMPLETED_MESSAGE = 'Loopback endpoint completed the custom tool.';

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

async function writeExternalRoutingFixture(endpointUrl: string): Promise<void> {
  await fs.writeFile(TOOL_DEFINITION_FILE, JSON.stringify({
    name: EXTERNAL_TOOL_NAME,
    description: 'Routes this custom-only test tool to the loopback endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
  }, null, 2), 'utf-8');
  await fs.writeFile(ENDPOINT_CONFIG_FILE, JSON.stringify({
    version: 1,
    url: endpointUrl,
    timeoutMs: 1_000,
    headers: {},
  }, null, 2), 'utf-8');
  await fs.writeFile(PROCESSOR_CONFIG_FILE, JSON.stringify({
    version: 1,
    httpEndpointConfigFile: ENDPOINT_CONFIG_FILE,
    processors: [],
    routingStrategy: [
      { strategy: 'request-to-external', mode: 'direct' },
      { strategy: 'response-from-external', mode: 'direct' },
    ],
  }, null, 2), 'utf-8');
  await fs.writeFile(TOOL_CONFIG_FILE, JSON.stringify({
    version: 1,
    definitions: [{
      id: 'external-custom-tool',
      toolDefinitionFile: TOOL_DEFINITION_FILE,
    }],
    processorConfigFile: PROCESSOR_CONFIG_FILE,
  }, null, 2), 'utf-8');
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [{
      id: 'selected',
      rootDir: ROOT_DIR,
      host: '127.0.0.1',
      port: 4914,
      lineEnding: 'auto',
      logsDir: LOGS_DIR,
      tools: {
        toolConfigFile: TOOL_CONFIG_FILE,
        enabled: [EXTERNAL_TOOL_NAME],
      },
    }],
  });
}

async function startLoopbackEndpoint(): Promise<LoopbackEndpoint> {
  const calls: CapturedEndpointCall[] = [];
  const failures: unknown[] = [];
  const sockets = new Set<Socket>();
  let requestCount = 0;

  const server = createServer((request, response) => {
    requestCount++;
    handleEndpointRequest(request, response, calls, failures);
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
      const body = JSON.stringify({
        results: [{
          id: call.id,
          status: 'completed',
          message: COMPLETED_MESSAGE,
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

async function connectMcpServer(runtime: LoadedApplicationRuntime): Promise<ConnectedMcpPair> {
  const server = createMCPServer({
    configStore: createConfigStore(runtime),
    logger: {
      logToolCall() {},
      logToolResult() {},
    },
    toolService: createWorkspaceToolService(runtime.toolCatalog),
  });
  const client = new Client({ name: 'external-routing-integration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

async function cleanupRuntimeResources(options: {
  readonly pair: ConnectedMcpPair | undefined;
  readonly runtime: LoadedApplicationRuntime | undefined;
  readonly endpoint: LoopbackEndpoint;
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
  try {
    await options.endpoint.close();
  } catch (error: unknown) {
    errors.push(error);
  }

  if (errors.length > 0) {
    throw errors[0];
  }
}

async function testExternalRoutingThroughRuntimeAndMcp(): Promise<void> {
  const endpoint = await startLoopbackEndpoint();
  let runtime: LoadedApplicationRuntime | undefined;
  let pair: ConnectedMcpPair | undefined;

  try {
    await writeExternalRoutingFixture(`${endpoint.baseUrl}/canonical-tool`);
    runtime = loadApplicationRuntime({
      homeDir: HOME_DIR,
      workspaceId: 'selected',
      env: {},
    });
    pair = await connectMcpServer(runtime);

    const listed = await pair.client.listTools();
    assertEqual(listed.tools.length, 1, 'tools/list should expose only the selected custom-only tool.');
    assertEqual(
      listed.tools[0]?.name,
      EXTERNAL_TOOL_NAME,
      'tools/list should expose the configured custom-only tool identity.',
    );

    const invalid = await pair.client.callTool({
      name: EXTERNAL_TOOL_NAME,
      arguments: {},
    });
    assertEqual(invalid.isError, true, 'Invalid custom arguments should return an MCP tool error.');
    assertIncludes(
      getTextContent(invalid),
      'configured input schema',
      'Invalid custom arguments should fail before external execution.',
    );
    assertEqual(endpoint.requestCount(), 0, 'Invalid arguments must not request the external endpoint.');

    const validArguments = { value: 'from MCP client' };
    const completed = await pair.client.callTool({
      name: EXTERNAL_TOOL_NAME,
      arguments: validArguments,
    });
    assertEqual(completed.isError, false, 'Canonical completed responses should become successful MCP results.');
    assertEqual(
      getTextContent(completed),
      COMPLETED_MESSAGE,
      'The canonical completed message should reach the MCP client unchanged.',
    );
    assertEqual(endpoint.requestCount(), 1, 'Exactly one valid tool call should request the endpoint once.');
    assertEqual(endpoint.failures.length, 0, 'The endpoint should receive one valid canonical request.');
    assertEqual(endpoint.calls.length, 1, 'The endpoint should parse exactly one canonical request.');

    const captured = endpoint.calls[0];
    assert(captured !== undefined, 'The valid call should be captured by the loopback endpoint.');
    assertEqual(captured.method, 'POST', 'External routing should send canonical calls with HTTP POST.');
    const canonicalCall = captured.request.calls[0];
    assertEqual(canonicalCall.name, EXTERNAL_TOOL_NAME, 'Canonical request should preserve the custom tool name.');
    assertEqual(
      JSON.stringify(canonicalCall.arguments),
      JSON.stringify(validArguments),
      'Canonical request should preserve the MCP tool arguments.',
    );
    assert(
      /^call_[0-9a-f-]{36}$/i.test(canonicalCall.id),
      'Canonical request should use the MCP runtime generated call ID.',
    );
  } finally {
    await cleanupRuntimeResources({ pair, runtime, endpoint });
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external routing through startup runtime and MCP',
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'routes a custom-only tool through the loopback endpoint', run: testExternalRoutingThroughRuntimeAndMcp },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

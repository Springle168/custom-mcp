import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { readFile } from 'node:fs/promises';
import { createMCPServer } from '../../src/runtime/mcp-server.js';
import type { JsonObject } from '../../src/config/json-file.js';
import { compileWorkspaceToolCatalog } from '../../src/tools/catalog.js';
import type { CompiledCustomToolDefinition } from '../../src/tools/custom-tool-config.js';
import { compileInputSchemaValidator } from '../../src/tools/input-schema-validator.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import type { ToolInvocationContext } from '../../src/runtime/tool-invocation-context.js';
import {
  createWorkspaceToolService,
  getCompiledBuiltInTools,
  type WorkspaceToolService,
} from '../../src/tools/index.js';
import { createTestConfigStore } from '../helpers/runtime-config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

interface ConnectedPair {
  readonly client: Client;
  readonly server: Server;
}

function textError(text: string): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
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
  return String((first as { readonly text?: unknown }).text ?? '');
}

function createLogger() {
  return {
    logToolCall() {},
    logToolResult() {},
  };
}

async function readPackageVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf-8'),
  );

  if (
    typeof manifest !== 'object'
    || manifest === null
    || !('version' in manifest)
    || typeof manifest.version !== 'string'
  ) {
    throw new Error('package.json must define a string version.');
  }

  return manifest.version;
}

function createSpyService(): {
  readonly service: WorkspaceToolService;
  readonly listCalls: () => number;
  readonly routeCalls: () => number;
  readonly lastInvocation: () => ToolInvocationContext | undefined;
} {
  const definitions = Object.freeze([
    {
      name: 'read_file' as const,
      description: 'Spy read tool',
      inputSchema: { type: 'object' },
    },
  ]);
  let listCallCount = 0;
  let routeCallCount = 0;
  let lastToolInvocation: ToolInvocationContext | undefined;

  return {
    listCalls: () => listCallCount,
    routeCalls: () => routeCallCount,
    lastInvocation: () => lastToolInvocation,
    service: Object.freeze({
      getDefinitions() {
        listCallCount++;
        return definitions;
      },
      async routeToolCall(name, _args, _context, invocation) {
        routeCallCount++;
        lastToolInvocation = invocation;
        return textError(`Unknown tool: ${name}`);
      },
    } satisfies WorkspaceToolService),
  };
}

function createCustomOnlyService(): WorkspaceToolService {
  const inputSchema: JsonObject = Object.freeze({
    type: 'object',
    properties: Object.freeze({ value: Object.freeze({ type: 'string' }) }),
    required: Object.freeze(['value']),
    additionalProperties: false,
  });
  const custom: CompiledCustomToolDefinition = Object.freeze({
    definition: Object.freeze({
      name: 'custom_tool',
      description: 'Custom-only MCP integration tool',
      inputSchema,
    }),
    validator: compileInputSchemaValidator(inputSchema),
    source: Object.freeze({
      toolConfigFilePath: 'E:/tools/tool-config.json',
      definitionIndex: 0,
      referenceId: 'custom-tool',
      toolDefinitionFilePath: 'E:/tools/custom-tool.json',
    }),
  });
  const catalog = compileWorkspaceToolCatalog({
    builtInTools: getCompiledBuiltInTools(),
    customDefinitions: [custom],
    exposure: { mode: 'enable', names: ['custom_tool'] },
    workspaceConfigFilePath: 'E:/config/workspace.json',
  });
  return createWorkspaceToolService(catalog);
}

async function connectServer(service: WorkspaceToolService): Promise<ConnectedPair> {
  const server = createMCPServer({
    configStore: createTestConfigStore({ rootDir: process.cwd() }),
    logger: createLogger(),
    toolService: service,
  });
  const client = new Client({ name: 'tool-exposure-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, server };
}

async function closePair(pair: ConnectedPair): Promise<void> {
  await pair.client.close();
  await pair.server.close();
}

async function testListAndCallUsePassedService(): Promise<void> {
  const spy = createSpyService();
  const pair = await connectServer(spy.service);

  try {
    const listResult = await pair.client.listTools();
    assertEqual(spy.listCalls(), 1, 'tools/list should call the passed service getDefinitions()');
    assertEqual(listResult.tools.length, 1, 'tools/list should return the service definitions');
    assertEqual(listResult.tools[0]?.name, 'read_file', 'tools/list should preserve definition contents');
    assert(listResult.tools !== spy.service.getDefinitions(), 'Protocol response should not expose the internal readonly array');

    const callResult = await pair.client.callTool({ name: 'write_file', arguments: {} });
    assertEqual(spy.routeCalls(), 1, 'tools/call should call routeToolCall() on the same passed service');
    assertEqual(callResult.isError, true, 'Excluded tool should remain an error through the MCP boundary');
    assertEqual(getTextContent(callResult), 'Unknown tool: write_file', 'MCP call should return the service unknown-tool error');
    const invocation = spy.lastInvocation();
    assert(invocation !== undefined, 'MCP tools/call should pass SDK metadata into the tool invocation');
    assert(Object.isFrozen(invocation), 'MCP invocation context should be frozen at the handler boundary');
    assert(invocation.callId.startsWith('call_'), 'MCP invocation should receive a server-generated call ID');
    assert(
      typeof invocation.signal === 'object' && invocation.signal !== null,
      'MCP invocation should receive the SDK cancellation signal',
    );
  } finally {
    await closePair(pair);
  }
}

async function testServerReportsPackageVersion(): Promise<void> {
  const pair = await connectServer(createSpyService().service);

  try {
    const serverInfo = pair.client.getServerVersion();
    assert(serverInfo !== undefined, 'MCP initialization should report server information');
    assertEqual(serverInfo.name, 'custom-mcp', 'MCP initialization should report the server name');
    assertEqual(
      serverInfo.version,
      await readPackageVersion(),
      'MCP initialization should report the package version',
    );
  } finally {
    await closePair(pair);
  }
}

async function testTwoServersShareCallerOwnedService(): Promise<void> {
  const spy = createSpyService();
  const first = await connectServer(spy.service);
  const second = await connectServer(spy.service);

  try {
    await first.client.listTools();
    await second.client.listTools();
    await first.client.callTool({ name: 'hidden-one', arguments: {} });
    await second.client.callTool({ name: 'hidden-two', arguments: {} });

    assertEqual(spy.listCalls(), 2, 'Both servers should read definitions from the caller-owned service');
    assertEqual(spy.routeCalls(), 2, 'Both servers should route calls through the same caller-owned service');
  } finally {
    await closePair(first);
    await closePair(second);
  }
}

async function testCustomOnlyToolListsValidatesAndReturnsUnavailable(): Promise<void> {
  const pair = await connectServer(createCustomOnlyService());
  try {
    const listResult = await pair.client.listTools();
    assertEqual(listResult.tools.length, 1, 'Exposure should list only the custom-only tool');
    assertEqual(listResult.tools[0]?.name, 'custom_tool', 'tools/list should expose custom identity');

    const invalid = await pair.client.callTool({ name: 'custom_tool', arguments: {} });
    assertIncludes(getTextContent(invalid), 'configured input schema', 'MCP call should use effective validation');

    const unavailable = await pair.client.callTool({
      name: 'custom_tool',
      arguments: { value: 'ok' },
    });
    assertIncludes(
      getTextContent(unavailable),
      'no execution route is configured',
      'Valid custom-only calls should reach unavailable executor',
    );
  } finally {
    await closePair(pair);
  }
}

async function testIndexDoesNotUseUnfilteredRegistryEntrypoints(): Promise<void> {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf-8');

  assert(!source.includes('getAllToolDefinitions'), 'src/index.ts should not import the full definitions registry');
  assert(!source.includes('routeToolCall'), 'src/index.ts should not import an unfiltered global router');
  assertIncludes(source, 'createWorkspaceToolService', 'src/index.ts should construct the workspace tool service once');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing MCP server workspace tool exposure wiring',
    tests: [
      { name: 'list and call use passed service', run: testListAndCallUsePassedService },
      { name: 'server reports the package version', run: testServerReportsPackageVersion },
      { name: 'two servers share caller-owned service', run: testTwoServersShareCallerOwnedService },
      { name: 'custom-only tool lists, validates, and returns unavailable', run: testCustomOnlyToolListsValidatesAndReturnsUnavailable },
      { name: 'index avoids unfiltered registry entrypoints', run: testIndexDoesNotUseUnfilteredRegistryEntrypoints },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

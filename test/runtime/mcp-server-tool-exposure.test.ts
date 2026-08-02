import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMCPServer } from '../../src/runtime/mcp-server.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import type { WorkspaceToolService } from '../../src/tools/index.js';
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

function createSpyService(): {
  readonly service: WorkspaceToolService;
  readonly listCalls: () => number;
  readonly routeCalls: () => number;
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

  return {
    listCalls: () => listCallCount,
    routeCalls: () => routeCallCount,
    service: Object.freeze({
      getDefinitions() {
        listCallCount++;
        return definitions;
      },
      async routeToolCall(name) {
        routeCallCount++;
        return textError(`Unknown tool: ${name}`);
      },
    } satisfies WorkspaceToolService),
  };
}

async function connectServer(service: WorkspaceToolService): Promise<ConnectedPair> {
  const server = createMCPServer({
    configStore: createTestConfigStore({ rootDir: process.cwd() }),
    logger: createLogger(),
    toolService: service,
    getSessionId: () => 'test-session',
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

async function testIndexDoesNotUseUnfilteredRegistryEntrypoints(): Promise<void> {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../../src/index.ts', import.meta.url), 'utf-8'));

  assert(!source.includes('getAllToolDefinitions'), 'src/index.ts should not import the full definitions registry');
  assert(!source.includes('routeToolCall'), 'src/index.ts should not import an unfiltered global router');
  assertIncludes(source, 'createWorkspaceToolService', 'src/index.ts should construct the workspace tool service once');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing MCP server workspace tool exposure wiring',
    tests: [
      { name: 'list and call use passed service', run: testListAndCallUsePassedService },
      { name: 'two servers share caller-owned service', run: testTwoServersShareCallerOwnedService },
      { name: 'index avoids unfiltered registry entrypoints', run: testIndexDoesNotUseUnfilteredRegistryEntrypoints },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

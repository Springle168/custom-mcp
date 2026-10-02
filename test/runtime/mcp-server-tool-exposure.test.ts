import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { readFile } from 'node:fs/promises';
import { createMCPServer } from '../../src/runtime/mcp/mcp-server.js';
import type { RuntimeRulesConfig } from '../../src/config.js';
import { compileWorkspaceToolCatalog } from '../../src/tools/catalog.js';
import type { CompiledCustomToolDefinition } from '../../src/tools/custom-tool-config.js';
import { compileInputSchemaValidator } from '../../src/tools/input-schema-validator.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import type { ToolInvocationContext } from '../../src/runtime/invocation/tool-invocation-context.js';
import { runWithRequestHeaderContext } from '../../src/runtime/request/request-context.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request/request-header-view.js';
import type { JsonObject } from '../../src/config/json-file.js';
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

function matchingRules(): RuntimeRulesConfig {
  return {
    requestHeaders: {
      onInitialize: [],
      onCallToolResult: [{
        match: [{ name: 'x-client', value: 'android-studio' }],
        enable: ['structuredContentDup'],
      }],
    },
  };
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

function createRichResultService(): WorkspaceToolService {
  return Object.freeze({
    getDefinitions() {
      return [{
        name: 'read_file',
        description: 'Rich result test tool',
        inputSchema: { type: 'object' },
      }];
    },
    async routeToolCall() {
      return {
        content: [
          { type: 'text', text: 'before' },
          {
            type: 'image',
            data: 'aW1hZ2UtZGF0YQ==',
            mimeType: 'image/png',
            _meta: { 'example.com/image-id': 'image-1' },
          },
          { type: 'text', text: 'after' },
        ],
        structuredContent: { width: 800, height: 600 },
        _meta: { 'example.com/result-id': 'result-1' },
        extension: { retained: true },
        isError: false,
      } satisfies ToolCallResult;
    },
  } satisfies WorkspaceToolService);
}

async function connectServer(
  service: WorkspaceToolService,
  rules: RuntimeRulesConfig = { requestHeaders: { onInitialize: [], onCallToolResult: [] } },
): Promise<ConnectedPair> {
  const server = createMCPServer({
    configStore: createTestConfigStore({ rootDir: process.cwd(), rules }),
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

async function testRichResultSurvivesMCPRoundTrip(): Promise<void> {
  const pair = await connectServer(createRichResultService());
  try {
    const result = await pair.client.callTool({ name: 'read_file', arguments: {} });
    assert(
      'content' in result && Array.isArray(result.content),
      'MCP rich result should use the standard content response shape',
    );

    assertEqual(result.content.length, 3, 'MCP round trip should preserve every content block');
    assertEqual(result.content[0]?.type, 'text', 'MCP round trip should preserve leading text');
    assertEqual(result.content[1]?.type, 'image', 'MCP round trip should preserve image position');
    assertEqual(result.content[2]?.type, 'text', 'MCP round trip should preserve trailing text');

    const image = result.content[1];
    assert(image?.type === 'image', 'Expected the second wire content block to be an image');
    assertEqual(image.data, 'aW1hZ2UtZGF0YQ==', 'MCP round trip should preserve image base64');
    assertEqual(image.mimeType, 'image/png', 'MCP round trip should preserve image MIME type');
    assertEqual(
      image._meta?.['example.com/image-id'],
      'image-1',
      'MCP round trip should preserve image metadata',
    );
    assert(
      typeof result.structuredContent === 'object'
      && result.structuredContent !== null,
      'MCP round trip should preserve structured content',
    );
    assertEqual(
      (result.structuredContent as Record<string, unknown>).width,
      800,
      'MCP round trip should preserve structured content values',
    );
    assertEqual(result._meta?.['example.com/result-id'], 'result-1', 'MCP round trip should preserve result metadata');
    assertEqual(
      (result.extension as { readonly retained?: unknown } | undefined)?.retained,
      true,
      'MCP round trip should preserve top-level extension fields',
    );
  } finally {
    await closePair(pair);
  }
}

async function testStructuredContentDupRichResultSurvivesMCPRoundTrip(): Promise<void> {
  const pair = await connectServer(createRichResultService(), matchingRules());
  try {
    const result = await runWithRequestHeaderContext(
      createStrictRequestHeaderView(['X-Client', 'android-studio']),
      () => pair.client.callTool({ name: 'read_file', arguments: {} }),
    );
    assert(
      'content' in result && Array.isArray(result.content),
      'MCP adapted rich result should use the standard content response shape',
    );
    assert(
      typeof result.structuredContent === 'object'
      && result.structuredContent !== null,
      'Matched rich result should include structuredContentDup wrapper',
    );

    const wrapper = result.structuredContent as Record<string, unknown>;
    assert(Array.isArray(wrapper.content), 'Wire wrapper should contain the full content array');
    assertEqual(wrapper.content.length, 3, 'Wire wrapper should preserve every content block');
    assertEqual(
      (wrapper.content[1] as { readonly type?: unknown }).type,
      'image',
      'Wire wrapper should preserve image block order',
    );
    assertEqual(
      (wrapper.content[1] as { readonly data?: unknown }).data,
      'aW1hZ2UtZGF0YQ==',
      'Wire wrapper should preserve image base64',
    );
    assertEqual(wrapper.isError, false, 'Wire wrapper should preserve normalized success state');
    assert(!('width' in wrapper), 'Matched policy should overwrite tool-owned structured content');
    assertEqual(result._meta?.['example.com/result-id'], 'result-1', 'Adaptation should preserve top-level metadata');
    assertEqual(
      (result.extension as { readonly retained?: unknown } | undefined)?.retained,
      true,
      'Adaptation should preserve top-level extension fields',
    );
  } finally {
    await closePair(pair);
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing MCP server workspace tool exposure wiring',
    tests: [
      { name: 'list and call use passed service', run: testListAndCallUsePassedService },
      { name: 'server reports the package version', run: testServerReportsPackageVersion },
      { name: 'two servers share caller-owned service', run: testTwoServersShareCallerOwnedService },
      { name: 'custom-only tool lists, validates, and returns unavailable', run: testCustomOnlyToolListsValidatesAndReturnsUnavailable },
      { name: 'rich result survives MCP round trip', run: testRichResultSurvivesMCPRoundTrip },
      { name: 'structuredContentDup rich result survives MCP round trip', run: testStructuredContentDupRichResultSurvivesMCPRoundTrip },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

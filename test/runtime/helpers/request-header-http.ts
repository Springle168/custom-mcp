import { once } from 'node:events';
import { request } from 'node:http';
import {
  CallToolResultSchema,
  InitializeResultSchema,
  JSONRPCResponseSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeRulesConfig } from '../../../src/config.js';
import { ApplicationLifecycle } from '../../../src/runtime/application/application-lifecycle.js';
import { createMcpHttpApp } from '../../../src/runtime/mcp/http-app.js';
import type { McpPostSession } from '../../../src/runtime/mcp/mcp-post-handler.js';
import type { McpPendingSession } from '../../../src/runtime/mcp/pending-session.js';
import type { WorkspaceToolService } from '../../../src/tools/index.js';
import type {
  ToolCallResultLogContext,
  ToolResultLogSummary,
} from '../../../src/runtime/invocation/tool-call-log-context.js';
import type { ToolCallResult } from '../../../src/tools/types.js';
import type { ToolCallPipelineDiagnostic } from '../../../src/runtime/invocation/tool-call-handler.js';
import type { RequestHeaderFeatureRegistry } from '../../../src/runtime/request/feature-contracts.js';
import { createRequestHeaderExtensions } from '../../../src/runtime/request/request-header-extensions.js';
import { createTestConfigStore } from '../../helpers/runtime-config.js';
import { assert, assertEqual } from '../../test-utils.js';

export const TOOL_HEADER = 'x-session-tools';
export const INSTRUCTIONS_HEADER = 'x-session-instructions';
export const RULES: RuntimeRulesConfig = {
  requestHeaders: {
    onInitialize: [
      { readHeader: TOOL_HEADER, apply: 'setToolList' },
      { readHeader: INSTRUCTIONS_HEADER, apply: 'setInstructions' },
    ],
    onCallToolResult: [
      {
        match: [{ name: 'x-result-client', value: 'duplicate' }],
        enable: ['structuredContentDup'],
      },
    ],
  },
};

export function initialize(id: string | number = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'header-integration', version: '1.0.0' },
    },
  };
}

export interface HttpReply {
  readonly status: number;
  readonly sessionId: string | undefined;
  readonly text: string;
  readonly message: unknown;
}

// Raw headers retain duplicate field lines instead of fetch/Headers coalescing them.
export async function post(
  url: string,
  body: unknown,
  headers: readonly string[] = [],
): Promise<HttpReply> {
  const serializedBody = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: [
          'Host',
          new URL(url).host,
          'Content-Type',
          'application/json',
          'Content-Length',
          String(Buffer.byteLength(serializedBody)),
          'Accept',
          'application/json, text/event-stream',
          ...headers,
        ],
      },
      (res) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const data = text.split('\n').find((line) => line.startsWith('data: '));
            const serialized = data === undefined ? text : data.slice(6);
            const sid = res.headers['mcp-session-id'];
            resolve({
              status: res.statusCode ?? 0,
              sessionId: typeof sid === 'string' ? sid : undefined,
              text,
              message: serialized.trim() === '' ? undefined : JSON.parse(serialized),
            });
          } catch (error: unknown) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error('HTTP integration request did not settle')));
    req.end(serializedBody);
  });
}

/** Real HTTP fixture shared only by the request-header integration suites. */
export async function createHarness(
  rules: RuntimeRulesConfig = RULES,
  failInfoLogging = false,
  registry?: RequestHeaderFeatureRegistry,
) {
  const sessions = new Map<string, McpPostSession>();
  const pendingSessions = new Set<McpPendingSession>();
  const messages: string[] = [];
  const resultPolicies: (ToolResultLogSummary | undefined)[] = [];
  const diagnostics: ToolCallPipelineDiagnostic[] = [];
  const calls: string[] = [];
  const definitions = ['alpha_tool', 'custom_only_tool'].map((name) => ({
    name,
    description: `Tests ${name}`,
    inputSchema: { type: 'object' },
  }));
  const service: WorkspaceToolService = {
    getDefinitions: () => definitions,
    async routeToolCall(name) {
      calls.push(name);
      return { content: [{ type: 'text', text: `Executed ${name}` }], isError: false };
    },
  };
  const logger = {
    info(message: string) {
      messages.push(message);
      if (failInfoLogging) {
        throw new Error('Policy logger unavailable');
      }
    },
    logToolCall() {},
    logToolResult(
      _name: string,
      _result: ToolCallResult,
      _duration: number,
      context: ToolCallResultLogContext,
    ) {
      resultPolicies.push(context.resultSummary);
    },
  };
  const app = createMcpHttpApp({
    configStore: createTestConfigStore({ rootDir: process.cwd(), rules }),
    extensions: createRequestHeaderExtensions(rules, logger, registry),
    toolService: service,
    sessions,
    pendingSessions,
    logger,
    onToolCallDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    isAcceptingNewSessions: () => lifecycle.isAcceptingNewSessions,
    closeSession: (id) => lifecycle.closeSession(id),
  });
  const listener = app.listen(0, '127.0.0.1');
  const lifecycle: ApplicationLifecycle = new ApplicationLifecycle({
    listener,
    sessions,
    pendingSessions,
    androidRuntime: { close() {} },
    externalRuntime: { close() {} },
    logger: { close() {} },
  });
  await once(listener, 'listening');
  const address = listener.address();
  assert(address !== null && typeof address !== 'string', 'Harness must listen on loopback');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    sessions,
    pendingSessions,
    messages,
    calls,
    resultPolicies,
    diagnostics,
    close: () => lifecycle.close(),
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function startSession(
  harness: Harness,
  headers: readonly string[] = [],
  batch = false,
) {
  const reply = await post(
    harness.url,
    batch ? [initialize('batch-id')] : initialize('init-id'),
    headers,
  );
  assertEqual(reply.status, 200, `Valid initialization should succeed; response: ${reply.text}`);
  const response = JSONRPCResponseSchema.parse(reply.message);
  assertEqual(response.id, batch ? 'batch-id' : 'init-id', 'Initialization must retain request ID');
  assert('result' in response, 'Initialization must return a result, not a protocol error');
  const result = InitializeResultSchema.parse(response.result);
  assert(reply.sessionId !== undefined, 'Successful initialization must return a session ID');
  // Publication must not wait for notifications/initialized from the client.
  assert(
    harness.sessions.has(reply.sessionId),
    'Completed initialize must publish before initialized notification',
  );
  assertEqual(harness.pendingSessions.size, 0, 'Published session must leave pending ownership');
  return { sessionId: reply.sessionId, result };
}

export async function list(harness: Harness, sessionId: string, headers: readonly string[] = []) {
  const reply = await post(harness.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, [
    'mcp-session-id',
    sessionId,
    ...headers,
  ]);
  assertEqual(reply.status, 200, 'tools/list should succeed');
  const response = JSONRPCResponseSchema.parse(reply.message);
  assert('result' in response, 'tools/list must return a result');
  return ListToolsResultSchema.parse(response.result).tools.map((tool) => tool.name);
}

export async function call(
  harness: Harness,
  sessionId: string,
  name: string,
  headers: readonly string[] = [],
) {
  const reply = await post(
    harness.url,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name, arguments: {} },
    },
    ['mcp-session-id', sessionId, ...headers],
  );
  assertEqual(reply.status, 200, 'tools/call should return an MCP result');
  const response = JSONRPCResponseSchema.parse(reply.message);
  assert('result' in response, 'tools/call must return a result');
  return CallToolResultSchema.parse(response.result);
}

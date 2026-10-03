import type { ExternalToolExecutor } from '../catalog.js';
import { textErrorResult } from '../results.js';
import type { ToolCallResult } from '../types.js';
import { immutableMap } from '../../utils/immutable-map.js';
import {
  createCanonicalRequest,
  type CanonicalContentBlock,
  type JsonObject,
} from './canonical-protocol.js';
import type { CompiledExternalRoutingConfig, CompiledHttpRoute } from './config.js';
import { createExternalHttpTransport, type ExternalHttpTransport } from './http-transport.js';
import {
  McpConnectionManager,
  type McpConnectionDiagnostic,
  type McpFailureCode,
} from './mcp-connection-manager.js';
import { ProcessorRunner } from './processor-runner.js';
import {
  ExternalRoutingRuntime,
  type ExternalRoutingOperationExchange,
  type ExternalRoutingRuntimeOutcome,
} from './runtime.js';
import {
  ExternalRoutingStrategyAdapter,
  type ExternalRoutingProcessorDrainDiagnostic,
  type ExternalRoutingStrategyOutcome,
} from './strategy-adapter.js';

export interface ExternalToolInvocation {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

interface RoutedExternalInvocation {
  readonly definitionId: string;
  readonly invocation: ExternalToolInvocation;
}

type ExternalRouteOutcome =
  | { readonly kind: 'result'; readonly result: ToolCallResult }
  | { readonly kind: 'failure'; readonly code: ExternalRoutingLocalFailureCode };

export interface ExternalRouteOperation {
  exchange(options: {
    readonly definitionId: string;
    readonly invocation: ExternalToolInvocation;
    readonly signal: AbortSignal;
  }): ExternalRoutingOperationExchange<ExternalRouteOutcome>;
}

export interface ExternalRoutingExecutorOptions {
  readonly routes: ExternalRouteOperation;
  readonly warmUp?: () => Promise<void>;
  /** Resources whose close can release an invocation's drain barrier. */
  readonly closeDrainingResources?: () => Promise<void>;
  /** Resources closed only after admitted invocations have drained. */
  readonly closeResources?: () => Promise<void>;
}

/** Workspace-owned admission and resource facade shared by HTTP and MCP routes. */
export class ExternalRoutingExecutor {
  readonly #runtime: ExternalRoutingRuntime<RoutedExternalInvocation, ExternalRouteOutcome>;
  readonly #warmUp: () => Promise<void>;
  readonly #closeDrainingResources: () => Promise<void>;
  readonly #closeResources: () => Promise<void>;
  #closePromise: Promise<void> | undefined;

  constructor(options: ExternalRoutingExecutorOptions) {
    this.#runtime = new ExternalRoutingRuntime((input, signal) =>
      options.routes.exchange({
        definitionId: input.definitionId,
        invocation: input.invocation,
        signal,
      }),
    );
    this.#warmUp = options.warmUp ?? (async () => undefined);
    this.#closeDrainingResources = options.closeDrainingResources ?? (async () => undefined);
    this.#closeResources = options.closeResources ?? (async () => undefined);
  }

  get activeExchangeCount(): number {
    return this.#runtime.activeExchangeCount;
  }

  get pendingExchangeCount(): number {
    return this.#runtime.pendingExchangeCount;
  }

  warmUp(): Promise<void> {
    return this.#warmUp();
  }

  async execute(definitionId: string, invocation: ExternalToolInvocation): Promise<ToolCallResult> {
    let outcome: ExternalRoutingRuntimeOutcome<ExternalRouteOutcome>;
    try {
      outcome = await this.#runtime.exchange({
        input: Object.freeze({ definitionId, invocation }),
        ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
      });
    } catch {
      return localFailureResult('external_internal_failed');
    }
    return mapRuntimeOutcome(outcome);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;

    // Manager close starts in the same turn as admission shutdown. It is the
    // final drain barrier for request-scoped SSE and cancellation POST bodies.
    const runtimeClose = this.#runtime.close();
    const drainingResourceClose = this.#closeDrainingResources();
    this.#closePromise = settleOrThrow([runtimeClose, drainingResourceClose]).then(() =>
      this.#closeResources(),
    );
    return this.#closePromise;
  }
}

export interface CreatedExternalRoutingExecutor {
  readonly executor: ExternalRoutingExecutor;
  readonly bindingsByDefinitionId: ReadonlyMap<string, ExternalToolExecutor>;
  readonly processorRunner?: ProcessorRunner;
  readonly httpTransport?: ExternalHttpTransport;
  readonly mcpConnectionManagers: ReadonlyMap<string, McpConnectionManager>;
}

export interface CreateExternalRoutingExecutorOptions {
  readonly onProcessorDrain?: (
    diagnostic: ExternalRoutingProcessorDrainDiagnostic,
  ) => void | Promise<void>;
  readonly onMcpConnectionDiagnostic?: (
    diagnostic: McpConnectionDiagnostic,
  ) => void | Promise<void>;
}

/** Creates one shared admission runtime with route-specific resource adapters. */
export function createExternalRoutingExecutor(
  config: CompiledExternalRoutingConfig,
  options: CreateExternalRoutingExecutorOptions = {},
): CreatedExternalRoutingExecutor {
  const routes = config.routes;
  if (routes.length === 0) {
    throw new Error('External routing resources require at least one compiled route.');
  }

  const httpRoutes = routes.filter(
    (route): route is CompiledHttpRoute => route.routingMode === 'http',
  );
  const needsProcessorRunner = httpRoutes.some(routeUsesProcessor);
  const processorRunner = needsProcessorRunner ? new ProcessorRunner() : undefined;
  const httpTransport = httpRoutes.length > 0 ? createExternalHttpTransport() : undefined;
  const adapters = new Map<
    string,
    (
      invocation: ExternalToolInvocation,
      signal: AbortSignal,
    ) => ExternalRoutingOperationExchange<ExternalRouteOutcome>
  >();

  if (httpTransport !== undefined) {
    for (const route of httpRoutes) {
      const strategy = new ExternalRoutingStrategyAdapter({
        route,
        processorsByName: config.processorsByName,
        ...(processorRunner === undefined ? {} : { processorRunner }),
        httpTransport,
        ...(options.onProcessorDrain === undefined
          ? {}
          : { onProcessorDrain: options.onProcessorDrain }),
      });
      adapters.set(route.definitionId, (invocation, signal) => {
        let request: ReturnType<typeof createCanonicalRequest>;
        try {
          request = createCanonicalRequest({
            id: invocation.callId,
            name: invocation.name,
            arguments: invocation.arguments as JsonObject,
          });
        } catch {
          return completedRouteFailure('external_internal_failed');
        }
        const exchange = strategy.exchange({ request, signal });
        return {
          settled: exchange.settled.then(mapHttpStrategyOutcome),
          drained: exchange.drained,
        };
      });
    }
  }

  const managers = new Map<string, McpConnectionManager>();
  for (const route of routes) {
    if (route.routingMode !== 'mcp') continue;
    let manager = managers.get(route.server.identity);
    if (manager === undefined) {
      manager = new McpConnectionManager(route.server, {
        ...(options.onMcpConnectionDiagnostic === undefined
          ? {}
          : { onDiagnostic: options.onMcpConnectionDiagnostic }),
      });
      managers.set(route.server.identity, manager);
    }
    adapters.set(route.definitionId, (invocation, signal) =>
      manager.callTool({
        name: invocation.name,
        arguments: invocation.arguments,
        signal,
      }),
    );
  }

  const routeOperation: ExternalRouteOperation = {
    exchange: ({ definitionId, invocation, signal }) => {
      const adapter = adapters.get(definitionId);
      return adapter?.(invocation, signal) ?? completedRouteFailure('external_internal_failed');
    },
  };
  const executor = new ExternalRoutingExecutor({
    routes: routeOperation,
    warmUp: async () => {
      await Promise.all([...managers.values()].map((manager) => manager.warmUp()));
    },
    closeDrainingResources: () =>
      settleOrThrow([...managers.values()].map((manager) => manager.close())),
    closeResources: () =>
      settleOrThrow([
        ...(processorRunner === undefined ? [] : [processorRunner.close()]),
        ...(httpTransport === undefined ? [] : [httpTransport.close()]),
      ]),
  });
  const bindingsByDefinitionId = new Map<string, ExternalToolExecutor>();
  for (const route of routes) {
    bindingsByDefinitionId.set(
      route.definitionId,
      Object.freeze({
        execute: (invocation: ExternalToolInvocation) =>
          executor.execute(route.definitionId, invocation),
      }),
    );
  }

  return Object.freeze({
    executor,
    bindingsByDefinitionId: immutableMap(bindingsByDefinitionId),
    ...(processorRunner === undefined ? {} : { processorRunner }),
    ...(httpTransport === undefined ? {} : { httpTransport }),
    mcpConnectionManagers: immutableMap(managers),
  });
}

function routeUsesProcessor(route: CompiledHttpRoute): boolean {
  return 'processor' in route.requestStage || 'processor' in route.responseStage;
}

function completedRouteFailure(
  code: ExternalRoutingLocalFailureCode,
): ExternalRoutingOperationExchange<ExternalRouteOutcome> {
  return Object.freeze({
    settled: Promise.resolve(Object.freeze({ kind: 'failure' as const, code })),
    drained: Promise.resolve(),
  });
}

function mapRuntimeOutcome(
  outcome: ExternalRoutingRuntimeOutcome<ExternalRouteOutcome>,
): ToolCallResult {
  if ('outcome' in outcome) {
    return outcome.outcome.kind === 'result'
      ? outcome.outcome.result
      : localFailureResult(outcome.outcome.code);
  }
  if (outcome.kind === 'capacity') return localFailureResult('external_capacity_exceeded');
  if (outcome.kind === 'cancelled') return localFailureResult('cancelled');
  return localFailureResult('external_internal_failed');
}

function mapHttpStrategyOutcome(outcome: ExternalRoutingStrategyOutcome): ExternalRouteOutcome {
  if (outcome.kind === 'failure') return { kind: 'failure', code: outcome.code };
  if ('error' in outcome.response) {
    return {
      kind: 'result',
      result: textErrorResult(
        `External endpoint rejected the tool call (${outcome.response.error.code}): ${outcome.response.error.message}`,
      ),
    };
  }
  const result = outcome.response.results[0];
  return {
    kind: 'result',
    result: {
      content: result.content.map(mapCanonicalContentBlock),
      isError: result.status !== 'completed',
    },
  };
}

/** Unknown stays JSON through response stages; only the MCP boundary textifies it. */
function mapCanonicalContentBlock(block: CanonicalContentBlock): ToolCallResult['content'][number] {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return { type: 'image', data: block.data, mimeType: block.mime_type };
    case 'unknown':
      return { type: 'text', text: JSON.stringify(block.value) };
  }
}

export type ExternalRoutingLocalFailureCode =
  | 'external_capacity_exceeded'
  | 'external_request_too_large'
  | 'external_transport_failed'
  | 'external_timeout'
  | 'external_response_too_large'
  | 'external_protocol_failed'
  | 'processor_failed'
  | 'processor_timeout'
  | McpFailureCode;

const LOCAL_FAILURE_MESSAGES: Readonly<Record<ExternalRoutingLocalFailureCode, string>> = {
  external_capacity_exceeded:
    'External routing capacity is full. The tool call did not start external work; retry after other calls finish.',
  external_request_too_large:
    'External routing could not send the tool call because the encoded request exceeded the local size limit. No HTTP request was started.',
  external_transport_failed:
    'External routing could not confirm an HTTP result. The external server may have executed the tool; custom-mcp will not retry or accept a late result. Retry only if the tool is safe to run again.',
  external_timeout:
    'The external HTTP exchange timed out without a confirmed result. The external server may have executed the tool; custom-mcp will not retry or accept a late result. Retry only if the tool is safe to run again.',
  external_response_too_large:
    'External routing rejected the HTTP response because it exceeded the local size limit. No confirmed external tool result was obtained.',
  external_protocol_failed:
    'External routing rejected an invalid HTTP or canonical response. No confirmed external tool result was obtained.',
  processor_failed:
    'An external routing Processor failed or returned invalid output. No confirmed external tool result was obtained.',
  processor_timeout:
    'An external routing Processor timed out. If it was processing a response, the external server may already have executed the tool; retry only if the tool is safe to run again.',
  mcp_connection_failed:
    'External routing could not establish a downstream MCP session. No tool call was sent.',
  mcp_capability_missing:
    'The downstream MCP server did not advertise Tool capability. No tool call was sent.',
  mcp_call_failed:
    'The downstream MCP server rejected the tool call. No confirmed tool result was obtained.',
  mcp_timeout:
    'The downstream MCP operation timed out. The server may have executed the tool; custom-mcp will not retry or accept a late result.',
  mcp_protocol_failed:
    'External routing rejected an invalid downstream MCP response. No confirmed tool result was obtained.',
  mcp_result_unsupported:
    'The downstream MCP result uses content that custom-mcp does not support.',
  mcp_transport_failed:
    'The downstream MCP transport failed without a confirmed result. The server may have executed the tool; custom-mcp will not retry automatically.',
  external_internal_failed:
    'External routing encountered an internal failure and did not obtain a confirmed result. Retry only after checking server diagnostics and whether the tool is safe to run again.',
  cancelled:
    'The external tool call was cancelled locally. The external server may have executed the tool; custom-mcp will not accept a late result or retry automatically.',
};

function localFailureResult(code: ExternalRoutingLocalFailureCode): ToolCallResult {
  return textErrorResult(LOCAL_FAILURE_MESSAGES[code]);
}

async function settleOrThrow(operations: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0)
    throw new AggregateError(failures, 'External routing resource shutdown failed.');
}

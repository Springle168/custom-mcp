import type { ExternalToolExecutor } from '../catalog.js';
import { textErrorResult } from '../results.js';
import type { ToolCallResult } from '../types.js';
import { immutableMap } from '../../utils/immutable-map.js';
import { createCanonicalRequest, type JsonObject } from './canonical-protocol.js';
import type {
  CompiledExternalRoute,
  CompiledExternalRoutingConfig,
} from './config.js';
import {
  createExternalHttpTransport,
  type ExternalHttpTransport,
} from './http-transport.js';
import { ProcessorRunner } from './processor-runner.js';
import {
  ExternalRoutingRuntime,
  type ExternalRoutingRuntimeOutcome,
} from './runtime.js';
import {
  ExternalRoutingStrategyAdapter,
  type ExternalRoutingProcessorDrainDiagnostic,
  type ExternalRoutingStrategyOutcome,
  type ExternalRoutingStrategyExchange,
} from './strategy-adapter.js';

export interface ExternalToolInvocation {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

interface RoutedCanonicalRequest {
  readonly definitionId: string;
  readonly request: ReturnType<typeof createCanonicalRequest>;
}

export interface ExternalRoutingStrategyOperation {
  exchange(options: {
    readonly definitionId: string;
    readonly request: ReturnType<typeof createCanonicalRequest>;
    readonly signal?: AbortSignal;
  }): ExternalRoutingStrategyExchange;
}

export interface ExternalRoutingExecutorOptions {
  readonly strategy: ExternalRoutingStrategyOperation;
  readonly closeResources?: () => Promise<void>;
}

/**
 * Workspace-owned admission and resource facade. Route-bound catalog executors
 * delegate here so all routes share one active/pending capacity pool.
 */
export class ExternalRoutingExecutor {
  readonly #runtime: ExternalRoutingRuntime<
    RoutedCanonicalRequest,
    ExternalRoutingStrategyOutcome
  >;
  readonly #closeResources: () => Promise<void>;
  #closePromise: Promise<void> | undefined;

  constructor(options: ExternalRoutingExecutorOptions) {
    this.#runtime = new ExternalRoutingRuntime((input, signal) =>
      options.strategy.exchange({
        definitionId: input.definitionId,
        request: input.request,
        signal,
      }));
    this.#closeResources = options.closeResources ?? (async () => undefined);
  }

  get activeExchangeCount(): number {
    return this.#runtime.activeExchangeCount;
  }

  get pendingExchangeCount(): number {
    return this.#runtime.pendingExchangeCount;
  }

  async execute(
    definitionId: string,
    invocation: ExternalToolInvocation,
  ): Promise<ToolCallResult> {
    let request: ReturnType<typeof createCanonicalRequest>;
    try {
      request = createCanonicalRequest({
        id: invocation.callId,
        name: invocation.name,
        arguments: invocation.arguments as JsonObject,
      });
    } catch {
      return localFailureResult('external_internal_failed');
    }

    let outcome: ExternalRoutingRuntimeOutcome<ExternalRoutingStrategyOutcome>;
    try {
      outcome = await this.#runtime.exchange({
        input: Object.freeze({ definitionId, request }),
        ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
      });
    } catch {
      return localFailureResult('external_internal_failed');
    }

    return mapRuntimeOutcome(outcome);
  }

  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closePromise = this.#runtime.close()
      .then(() => this.#closeResources());
    return this.#closePromise;
  }
}

export interface CreatedExternalRoutingExecutor {
  readonly executor: ExternalRoutingExecutor;
  readonly bindingsByDefinitionId: ReadonlyMap<string, ExternalToolExecutor>;
  readonly processorRunner?: ProcessorRunner;
  readonly httpTransport: ExternalHttpTransport;
}

export interface CreateExternalRoutingExecutorOptions {
  /** Receives safe post-drain Processor cleanup diagnostics for application logging. */
  readonly onProcessorDrain?: (
    diagnostic: ExternalRoutingProcessorDrainDiagnostic,
  ) => void | Promise<void>;
}

/** Creates one shared external-routing resource graph and route-bound facades. */
export function createExternalRoutingExecutor(
  config: CompiledExternalRoutingConfig,
  options: CreateExternalRoutingExecutorOptions = {},
): CreatedExternalRoutingExecutor {
  const routes = [...config.routesByDefinitionId.values()];
  if (routes.length === 0) {
    throw new Error('External routing resources require at least one compiled route.');
  }

  const needsProcessorRunner = routes.some(routeUsesProcessor);
  const processorRunner = needsProcessorRunner ? new ProcessorRunner() : undefined;
  const httpTransport = createExternalHttpTransport();
  const strategiesByDefinitionId = new Map(routes.map((route) => [
    route.definitionId,
    new ExternalRoutingStrategyAdapter({
      route,
      processorsByName: config.processorsByName,
      ...(processorRunner === undefined ? {} : { processorRunner }),
      httpTransport,
      ...(options.onProcessorDrain === undefined
        ? {}
        : { onProcessorDrain: options.onProcessorDrain }),
    }),
  ]));
  const strategy: ExternalRoutingStrategyOperation = {
    exchange: ({ definitionId, request, signal }) => {
      const adapter = strategiesByDefinitionId.get(definitionId);
      if (adapter === undefined) {
        return completedStrategyFailure('external_internal_failed');
      }
      return adapter.exchange({ request, signal });
    },
  };
  const executor = new ExternalRoutingExecutor({
    strategy,
    closeResources: async () => {
      const results = await Promise.allSettled([
        ...(processorRunner === undefined ? [] : [processorRunner.close()]),
        httpTransport.close(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'External routing resource shutdown failed.');
      }
    },
  });
  const bindingsByDefinitionId = new Map<string, ExternalToolExecutor>();
  for (const route of routes) {
    bindingsByDefinitionId.set(route.definitionId, Object.freeze({
      execute: (invocation: ExternalToolInvocation) =>
        executor.execute(route.definitionId, invocation),
    }));
  }

  return Object.freeze({
    executor,
    bindingsByDefinitionId: immutableMap(bindingsByDefinitionId),
    ...(processorRunner === undefined ? {} : { processorRunner }),
    httpTransport,
  });
}

function routeUsesProcessor(route: CompiledExternalRoute): boolean {
  return 'processor' in route.requestStage || 'processor' in route.responseStage;
}

function completedStrategyFailure(
  code: 'external_internal_failed',
): ExternalRoutingStrategyExchange {
  return Object.freeze({
    settled: Promise.resolve(Object.freeze({ kind: 'failure' as const, code })),
    drained: Promise.resolve(),
  });
}

function mapRuntimeOutcome(
  outcome: ExternalRoutingRuntimeOutcome<ExternalRoutingStrategyOutcome>,
): ToolCallResult {
  if ('outcome' in outcome) {
    return mapStrategyOutcome(outcome.outcome);
  }
  if (outcome.kind === 'capacity') {
    return localFailureResult('external_capacity_exceeded');
  }
  if (outcome.kind === 'cancelled') {
    return localFailureResult('cancelled');
  }
  return localFailureResult('external_internal_failed');
}

function mapStrategyOutcome(outcome: ExternalRoutingStrategyOutcome): ToolCallResult {
  if (outcome.kind === 'failure') {
    return localFailureResult(outcome.code);
  }

  if ('error' in outcome.response) {
    return textErrorResult(
      `External endpoint rejected the tool call (${outcome.response.error.code}): ` +
      outcome.response.error.message,
    );
  }

  const result = outcome.response.results[0];
  if (result.status === 'completed') {
    return {
      content: [{ type: 'text', text: result.message }],
      isError: false,
    };
  }
  if (result.status === 'failed') {
    return textErrorResult(`External tool failed: ${result.message}`);
  }
  return textErrorResult(`External tool reported cancellation: ${result.message}`);
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
  | 'external_internal_failed'
  | 'cancelled';

const LOCAL_FAILURE_MESSAGES: Readonly<Record<ExternalRoutingLocalFailureCode, string>> = {
  external_capacity_exceeded:
    'External routing capacity is full. The tool call did not start a Processor or HTTP request; retry after other calls finish.',
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
  external_internal_failed:
    'External routing encountered an internal failure and did not obtain a confirmed result. Retry only after checking server diagnostics and whether the tool is safe to run again.',
  cancelled:
    'The external tool call was cancelled locally. The external server may have executed the tool; custom-mcp will not accept a late result or retry automatically.',
};

function localFailureResult(code: ExternalRoutingLocalFailureCode): ToolCallResult {
  return textErrorResult(LOCAL_FAILURE_MESSAGES[code]);
}

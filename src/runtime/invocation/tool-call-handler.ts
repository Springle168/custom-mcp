import { generateToolCallId } from '../mcp/mcp-identifiers.js';
import type { PreparedToolResult, RuntimeExtensions } from '../runtime-extensions.js';
import type { ToolInvocationContext, ToolRequestId } from './tool-invocation-context.js';
import type { ToolCallLogContext, ToolCallResultLogContext } from './tool-call-log-context.js';
import { createToolRuntimeContext, type ToolRuntimeContext } from './tool-context.js';
import { isToolCallResult } from './tool-result-validation.js';
import type { ConfigStore } from '../application/config-store.js';
import type { ToolCallResult } from '../../tools/types.js';
import { textErrorResult } from '../../tools/results.js';

const ROUTER_FAILURE_MESSAGE =
  'The tool execution failed unexpectedly. Check server diagnostics and retry only if the operation is safe to run again.';
const MALFORMED_RESULT_MESSAGE =
  'The tool returned an invalid result. Check server diagnostics and retry only if the operation is safe to run again.';

export interface ToolCallRequestLike {
  readonly params: {
    readonly name: string;
    readonly arguments?: unknown;
  };
}

/** The subset of MCP SDK request metadata consumed by the tool invocation pipeline. */
export interface ToolCallRequestMetadata {
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly requestId: ToolRequestId;
}

export interface ToolCallLogger {
  logToolCall(toolName: string, args: unknown, context: ToolCallLogContext): void | Promise<void>;
  logToolResult(
    toolName: string,
    result: ToolCallResult,
    durationMs: number,
    context: ToolCallResultLogContext,
  ): void | Promise<void>;
}

export type ToolCallRouter = (
  name: string,
  args: unknown,
  context: ToolRuntimeContext,
  invocation: ToolInvocationContext,
) => Promise<ToolCallResult>;

/**
 * Correlation-only pipeline diagnostics. Error objects, tool arguments, and
 * tool results stay out of this sink because they can contain user data.
 */
export interface ToolCallPipelineDiagnostic {
  readonly kind: 'router_exception' | 'malformed_result' | 'call_log_failed' | 'result_log_failed';
  readonly callId: string;
}

export type ToolCallDiagnosticSink = (
  diagnostic: ToolCallPipelineDiagnostic,
) => void | Promise<void>;

export interface CreateToolCallRequestHandlerOptions {
  readonly configStore: ConfigStore;
  readonly logger: ToolCallLogger;
  readonly routeToolCall: ToolCallRouter;
  readonly generateCallId?: () => string;
  readonly now?: () => number;
  readonly onDiagnostic?: ToolCallDiagnosticSink;
  readonly prepareToolResult?: RuntimeExtensions['prepareToolResult'];
}

export type ToolCallRequestHandler = (
  request: ToolCallRequestLike,
  metadata?: ToolCallRequestMetadata,
) => Promise<ToolCallResult>;

export function createToolCallRequestHandler(
  options: CreateToolCallRequestHandlerOptions,
): ToolCallRequestHandler {
  const now = options.now ?? Date.now;
  const generateCallId = options.generateCallId ?? generateToolCallId;
  const fallbackSignal = new AbortController().signal;

  return async (request, metadata) => {
    const { name, arguments: args } = request.params;
    const normalizedArgs = args === undefined ? {} : args;
    const startTime = now();
    const invocation = Object.freeze({
      callId: generateCallId(),
      requestId: metadata?.requestId,
      sessionId: metadata?.sessionId,
      signal: metadata?.signal ?? fallbackSignal,
    } satisfies ToolInvocationContext);
    const logContext: ToolCallLogContext = {
      sessionId: invocation.sessionId,
      callId: invocation.callId,
    };
    const snapshot = options.configStore.getSnapshot();
    const preparedResult = options.prepareToolResult?.(snapshot);
    const toolContext = createToolRuntimeContext(snapshot);

    const callLogged = await tryLogToolCall(
      options.logger,
      name,
      normalizedArgs,
      logContext,
      options.onDiagnostic,
    );
    let result: ToolCallResult;

    try {
      result = await options.routeToolCall(name, normalizedArgs, toolContext, invocation);
    } catch {
      emitToolCallDiagnostic(options.onDiagnostic, {
        kind: 'router_exception',
        callId: invocation.callId,
      });
      result = textErrorResult(ROUTER_FAILURE_MESSAGE);
    }

    if (!isToolCallResult(result)) {
      emitToolCallDiagnostic(options.onDiagnostic, {
        kind: 'malformed_result',
        callId: invocation.callId,
      });
      result = textErrorResult(MALFORMED_RESULT_MESSAGE);
    }

    const adaptedResult =
      preparedResult === undefined ? result : preparedResult.adaptResult(result);

    if (callLogged) {
      await tryLogToolResult(
        options.logger,
        name,
        adaptedResult,
        now() - startTime,
        logContext,
        preparedResult,
        options.onDiagnostic,
      );
    }

    return adaptedResult;
  };
}

async function tryLogToolCall(
  logger: ToolCallLogger,
  toolName: string,
  args: unknown,
  context: ToolCallLogContext,
  diagnosticSink: ToolCallDiagnosticSink | undefined,
): Promise<boolean> {
  try {
    await logger.logToolCall(toolName, args, context);
    return true;
  } catch {
    emitToolCallDiagnostic(diagnosticSink, {
      kind: 'call_log_failed',
      callId: context.callId,
    });
    return false;
  }
}

async function tryLogToolResult(
  logger: ToolCallLogger,
  toolName: string,
  result: ToolCallResult,
  durationMs: number,
  context: ToolCallLogContext,
  preparedResult: PreparedToolResult | undefined,
  diagnosticSink: ToolCallDiagnosticSink | undefined,
): Promise<void> {
  try {
    const resultSummary = preparedResult?.getLogSummary?.();
    await logger.logToolResult(toolName, result, durationMs, {
      ...context,
      ...(resultSummary === undefined ? {} : { resultSummary }),
    });
  } catch {
    emitToolCallDiagnostic(diagnosticSink, {
      kind: 'result_log_failed',
      callId: context.callId,
    });
  }
}

function emitToolCallDiagnostic(
  sink: ToolCallDiagnosticSink | undefined,
  diagnostic: ToolCallPipelineDiagnostic,
): void {
  if (sink === undefined) {
    return;
  }

  try {
    // Diagnostics run outside the response path; a slow or failing sink cannot
    // leak errors, delay the caller, or expose the original exception.
    void Promise.resolve(sink(Object.freeze({ ...diagnostic }))).catch(
      ignoreToolCallDiagnosticFailure,
    );
  } catch {
    // Synchronous sink failures are isolated just like rejected sink promises.
  }
}

function ignoreToolCallDiagnosticFailure(): void {
  // A diagnostics-only channel must never create an unhandled rejection.
}

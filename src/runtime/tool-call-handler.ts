import { generateToolCallId } from './mcp-identifiers.js';
import { getCurrentRequestHeaderView } from './request-context.js';
import {
  evaluateRequestHeaderPolicy,
  toRequestHeaderPolicyLogMetadata,
} from './request-header-policy.js';
import { adaptToolCallResultForRequestPolicy } from './tool-result-adapter.js';
import type {
  ToolCallLogContext,
  ToolCallResultLogContext,
} from './tool-call-log-context.js';
import { createToolRuntimeContext, type ToolRuntimeContext } from './tool-context.js';
import type { ConfigStore } from './config-store.js';
import type { ToolCallResult } from '../tools/types.js';

export interface ToolCallRequestLike {
  readonly params: {
    readonly name: string;
    readonly arguments?: unknown;
  };
}

export interface ToolCallLogger {
  logToolCall(
    toolName: string,
    args: unknown,
    context: ToolCallLogContext,
  ): void;
  logToolResult(
    toolName: string,
    result: ToolCallResult,
    durationMs: number,
    context: ToolCallResultLogContext,
  ): void;
}

export type ToolCallRouter = (
  name: string,
  args: unknown,
  context: ToolRuntimeContext,
) => Promise<ToolCallResult>;

export interface CreateToolCallRequestHandlerOptions {
  readonly configStore: ConfigStore;
  readonly logger: ToolCallLogger;
  readonly routeToolCall: ToolCallRouter;
  readonly getSessionId?: () => string | undefined;
  readonly generateCallId?: () => string;
  readonly now?: () => number;
}

export type ToolCallRequestHandler = (
  request: ToolCallRequestLike,
) => Promise<ToolCallResult>;

export function createToolCallRequestHandler(
  options: CreateToolCallRequestHandlerOptions,
): ToolCallRequestHandler {
  const now = options.now ?? Date.now;
  const generateCallId = options.generateCallId ?? generateToolCallId;

  return async (request) => {
    const { name, arguments: args } = request.params;
    const normalizedArgs = args === undefined ? {} : args;
    const startTime = now();
    const logContext: ToolCallLogContext = {
      sessionId: options.getSessionId?.(),
      callId: generateCallId(),
    };
    const snapshot = options.configStore.getSnapshot();
    const requestHeaderView = getCurrentRequestHeaderView();
    const requestPolicy = evaluateRequestHeaderPolicy(snapshot.rules, requestHeaderView);
    const toolContext = createToolRuntimeContext(snapshot);

    options.logger.logToolCall(name, normalizedArgs, logContext);

    const result = await options.routeToolCall(name, normalizedArgs, toolContext);
    const adaptedResult = adaptToolCallResultForRequestPolicy(result, requestPolicy);
    const resultLogContext: ToolCallResultLogContext = {
      ...logContext,
      requestHeaderPolicy: toRequestHeaderPolicyLogMetadata(requestPolicy),
    };

    options.logger.logToolResult(name, adaptedResult, now() - startTime, resultLogContext);
    return adaptedResult;
  };
}

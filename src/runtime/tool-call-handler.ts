import { getCurrentRequestHeaderView } from './request-context.js';
import { evaluateRequestHeaderPolicy } from './request-header-policy.js';
import { adaptToolCallResultForRequestPolicy } from './tool-result-adapter.js';
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
  logToolCall(toolName: string, args: Record<string, unknown>): void;
  logToolResult(toolName: string, result: ToolCallResult, durationMs: number): void;
}

export type ToolCallRouter = (
  name: string,
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
) => Promise<ToolCallResult>;

export interface CreateToolCallRequestHandlerOptions {
  readonly configStore: ConfigStore;
  readonly logger: ToolCallLogger;
  readonly routeToolCall: ToolCallRouter;
  readonly now?: () => number;
}

export type ToolCallRequestHandler = (
  request: ToolCallRequestLike,
) => Promise<ToolCallResult>;

export function createToolCallRequestHandler(
  options: CreateToolCallRequestHandlerOptions,
): ToolCallRequestHandler {
  const now = options.now ?? Date.now;

  return async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, unknown>;
    const startTime = now();
    const snapshot = options.configStore.getSnapshot();
    const requestHeaderView = getCurrentRequestHeaderView();
    const requestPolicy = evaluateRequestHeaderPolicy(snapshot.rules, requestHeaderView);
    const toolContext = createToolRuntimeContext(snapshot);

    options.logger.logToolCall(name, safeArgs);

    const result = await options.routeToolCall(name, safeArgs, toolContext);
    const adaptedResult = adaptToolCallResultForRequestPolicy(result, requestPolicy);

    options.logger.logToolResult(name, adaptedResult, now() - startTime);
    return adaptedResult;
  };
}

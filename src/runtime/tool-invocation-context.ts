export type ToolRequestId = string | number;

/**
 * Per-call transport metadata kept separate from workspace runtime capability.
 * The server-generated call ID is also the canonical external correlation ID.
 */
export interface ToolInvocationContext {
  readonly callId: string;
  readonly requestId: ToolRequestId | undefined;
  readonly sessionId: string | undefined;
  readonly signal: AbortSignal;
}

import type { RequestHeaderPolicyLogMetadata } from './request-header-policy.js';

export interface ToolCallLogContext {
  readonly sessionId: string | undefined;
  readonly callId: string;
}

export interface ToolCallResultLogContext extends ToolCallLogContext {
  readonly requestHeaderPolicy: RequestHeaderPolicyLogMetadata;
}

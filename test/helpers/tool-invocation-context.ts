import type { ToolInvocationContext } from '../../src/runtime/tool-invocation-context.js';

const DEFAULT_TEST_TOOL_INVOCATION_IDENTITY = Object.freeze({
  callId: 'test-tool-call',
  requestId: 'test-request',
  sessionId: 'test-session',
});

export function createTestToolInvocationContext(
  overrides: Partial<ToolInvocationContext> = {},
): ToolInvocationContext {
  return {
    callId: overrides.callId ?? DEFAULT_TEST_TOOL_INVOCATION_IDENTITY.callId,
    requestId: Object.prototype.hasOwnProperty.call(overrides, 'requestId')
      ? overrides.requestId
      : DEFAULT_TEST_TOOL_INVOCATION_IDENTITY.requestId,
    sessionId: Object.prototype.hasOwnProperty.call(overrides, 'sessionId')
      ? overrides.sessionId
      : DEFAULT_TEST_TOOL_INVOCATION_IDENTITY.sessionId,
    signal: overrides.signal ?? new AbortController().signal,
  };
}

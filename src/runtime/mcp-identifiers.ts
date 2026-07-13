import { randomUUID } from 'node:crypto';

export function generateMcpSessionId(): string {
  return `session_${randomUUID()}`;
}

export function generateToolCallId(): string {
  return `call_${randomUUID()}`;
}

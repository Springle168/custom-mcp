import { generateMcpSessionId, generateToolCallId } from '../../src/runtime/mcp/mcp-identifiers.js';
import { assert, runTestSuite } from '../test-utils.js';

const PREFIXED_UUID_RE =
  /^(session|call)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function testSessionIdsUseSessionPrefix(): void {
  const first = generateMcpSessionId();
  const second = generateMcpSessionId();

  assert(PREFIXED_UUID_RE.test(first), 'Session ID should contain the session_ prefix and a UUID');
  assert(first.startsWith('session_'), 'Session ID should use the session_ prefix');
  assert(first !== second, 'Generated session IDs should be unique');
}

function testToolCallIdsUseCallPrefix(): void {
  const first = generateToolCallId();
  const second = generateToolCallId();

  assert(PREFIXED_UUID_RE.test(first), 'Call ID should contain the call_ prefix and a UUID');
  assert(first.startsWith('call_'), 'Call ID should use the call_ prefix');
  assert(first !== second, 'Generated call IDs should be unique');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing MCP identifier generation',
    tests: [
      { name: 'session IDs use session prefix', run: testSessionIdsUseSessionPrefix },
      { name: 'tool call IDs use call prefix', run: testToolCallIdsUseCallPrefix },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

import { ApplicationDiagnostics } from '../../src/runtime/application-diagnostics.js';
import {
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

async function testFormatsOnlySafeStructuredMetadata(): Promise<void> {
  const messages: string[] = [];
  const diagnostics = new ApplicationDiagnostics();
  diagnostics.bind({
    info(message) {
      messages.push(message);
    },
  });

  diagnostics.onToolCallDiagnostic({ kind: 'router_exception', callId: 'call_test' });
  diagnostics.onExternalProcessorDrain({
    role: 'response.body-decoder',
    processorName: 'decoder',
    cleanupFailed: true,
    settledDurationMs: 12,
    drainDurationMs: 34,
    stdinBytes: 56,
    stdoutBytes: 78,
    stderrByteCount: 90,
    stderrCapturedByteCount: 10,
    stderrTruncated: true,
  });

  assertEqual(messages.length, 2, 'Each diagnostic should produce one logger message');
  assertIncludes(messages[0] ?? '', 'kind=router_exception', 'Tool-call diagnostic should retain its stable kind');
  assertIncludes(messages[0] ?? '', 'callId=call_test', 'Tool-call diagnostic should retain correlation');
  assertIncludes(messages[1] ?? '', 'cleanupFailed=true', 'Processor diagnostic should retain degraded cleanup state');
  assertNotIncludes(messages.join('\n'), 'stderr text', 'Diagnostics must not contain Processor stream contents');
}

async function testLoggerFailureNeverEscapesDiagnosticCallbacks(): Promise<void> {
  const diagnostics = new ApplicationDiagnostics();
  diagnostics.bind({
    info() {
      throw new Error('private logger failure');
    },
  });

  diagnostics.onToolCallDiagnostic({ kind: 'result_log_failed', callId: 'call_test' });
  diagnostics.onExternalProcessorDrain({
    role: 'request.canonical-filter',
    processorName: 'filter',
    cleanupFailed: false,
    settledDurationMs: 1,
    drainDurationMs: 1,
    stdinBytes: 1,
    stdoutBytes: 1,
    stderrByteCount: 0,
    stderrCapturedByteCount: 0,
    stderrTruncated: false,
  });
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing application diagnostics isolation',
    tests: [
      { name: 'formats safe structured metadata', run: testFormatsOnlySafeStructuredMetadata },
      { name: 'isolates logger failures', run: testLoggerFailureNeverEscapesDiagnosticCallbacks },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

import { ApplicationDiagnostics } from '../../src/runtime/application/application-diagnostics.js';
import {
  assert,
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
  diagnostics.onMcpConnectionDiagnostic({
    server: 'https://downstream.example/mcp',
    outcome: 'failed',
    phase: 'initialize',
    classification: 'mcp_timeout',
    durationMs: 42,
  });
  diagnostics.onExternalProcessorDrain({
    definitionId: 'external-route',
    toolName: 'external_tool',
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

  assertEqual(messages.length, 3, 'Each diagnostic should produce one logger message');
  assertIncludes(
    messages[0] ?? '',
    'kind=router_exception',
    'Tool-call diagnostic should retain its stable kind',
  );
  assertIncludes(
    messages[0] ?? '',
    'callId=call_test',
    'Tool-call diagnostic should retain correlation',
  );
  assertIncludes(
    messages[1] ?? '',
    'server=https://downstream.example/mcp',
    'MCP diagnostic should retain the safe endpoint identity',
  );
  assertIncludes(
    messages[1] ?? '',
    'classification=mcp_timeout',
    'MCP diagnostic should retain stable classification',
  );
  assertIncludes(
    messages[2] ?? '',
    'cleanupFailed=true',
    'Processor diagnostic should retain degraded cleanup state',
  );
  assertNotIncludes(
    messages.join('\n'),
    'stderr text',
    'Diagnostics must not contain Processor stream contents',
  );
  assertNotIncludes(
    messages.join('\n'),
    'Authorization',
    'Diagnostics must not contain static header names',
  );
}

async function testLoggerFailureNeverEscapesDiagnosticCallbacks(): Promise<void> {
  const diagnostics = new ApplicationDiagnostics();
  diagnostics.bind({
    info() {
      throw new Error('private logger failure');
    },
  });

  diagnostics.onToolCallDiagnostic({ kind: 'result_log_failed', callId: 'call_test' });
  diagnostics.onMcpConnectionDiagnostic({
    server: 'https://downstream.example/mcp',
    outcome: 'connected',
    phase: 'connect',
    durationMs: 1,
  });
  diagnostics.onExternalProcessorDrain({
    definitionId: 'external-route',
    toolName: 'external_tool',
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

async function testAsyncLoggerFailureUsesFallbackOnceWithoutUnhandledRejection(): Promise<void> {
  const fallbackMessages: string[] = [];
  const unhandledRejections: unknown[] = [];
  const originalStderrWrite = process.stderr.write;
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    fallbackMessages.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const diagnostics = new ApplicationDiagnostics();
    diagnostics.bind({
      info() {
        return Promise.reject(new Error('private async logger failure'));
      },
    });

    diagnostics.onToolCallDiagnostic({ kind: 'call_log_failed', callId: 'call_test' });
    diagnostics.onExternalProcessorDrain({
      definitionId: 'external-route',
      toolName: 'external_tool',
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

    await new Promise<void>((resolve) => setImmediate(resolve));

    assertEqual(
      fallbackMessages.length,
      1,
      'Repeated asynchronous logger failures should trigger fallback only once',
    );
    assertEqual(
      unhandledRejections.length,
      0,
      'Asynchronous logger failures must not create unhandled rejections',
    );
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    process.stderr.write = originalStderrWrite;
  }
}

async function testExternalProcessorDrainDoesNotWaitForAsyncLogger(): Promise<void> {
  let resolveLogger: (() => void) | undefined;
  const loggerCompletion = new Promise<void>((resolve) => {
    resolveLogger = resolve;
  });
  const diagnostics = new ApplicationDiagnostics();
  diagnostics.bind({
    info() {
      return loggerCompletion;
    },
  });

  const callbackResult = diagnostics.onExternalProcessorDrain({
    definitionId: 'external-route',
    toolName: 'external_tool',
    role: 'response.body-decoder',
    processorName: 'decoder',
    cleanupFailed: false,
    settledDurationMs: 1,
    drainDurationMs: 1,
    stdinBytes: 1,
    stdoutBytes: 1,
    stderrByteCount: 0,
    stderrCapturedByteCount: 0,
    stderrTruncated: false,
  });

  assertEqual(
    callbackResult,
    undefined,
    'External processor drain diagnostics must not wait for asynchronous logger completion',
  );
  assert(resolveLogger !== undefined, 'Asynchronous logger test should expose its completion');
  resolveLogger();
  await loggerCompletion;
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing application diagnostics isolation',
    tests: [
      { name: 'formats safe structured metadata', run: testFormatsOnlySafeStructuredMetadata },
      { name: 'isolates logger failures', run: testLoggerFailureNeverEscapesDiagnosticCallbacks },
      {
        name: 'observes asynchronous logger failures without unhandled rejections',
        run: testAsyncLoggerFailureUsesFallbackOnceWithoutUnhandledRejection,
      },
      {
        name: 'external processor drain does not wait for asynchronous logger',
        run: testExternalProcessorDrainDoesNotWaitForAsyncLogger,
      },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

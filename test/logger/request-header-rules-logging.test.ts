import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestHeaderPolicyLogMetadata } from '../../src/runtime/request-header-policy.js';
import type { ToolCallResultLogContext } from '../../src/runtime/tool-call-log-context.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import { Logger } from '../../src/utils/logger.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_LOGS_DIR = join(__dirname, '..', 'logs', 'request-header-rules-logging');
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/u;

function successResult(text = 'Succeeded.'): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

function errorResult(text = 'Failed.'): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

function metadata(options: {
  readonly rulesConfigured: boolean;
  readonly matchedRuleLocations?: readonly string[];
  readonly enabledFeatures?: readonly ['structuredContentDup'];
}): RequestHeaderPolicyLogMetadata {
  return {
    rulesConfigured: options.rulesConfigured,
    matchedRuleLocations: options.matchedRuleLocations ?? [],
    enabledFeatures: options.enabledFeatures ?? [],
  };
}

function resultLogContext(
  requestHeaderPolicy: RequestHeaderPolicyLogMetadata,
  callId = 'call_logger_test',
): ToolCallResultLogContext {
  return {
    sessionId: 'session_logger_test',
    callId,
    requestHeaderPolicy,
  };
}

async function prepareLogsDir(): Promise<void> {
  await rm(TEST_LOGS_DIR, { recursive: true, force: true });
  await mkdir(TEST_LOGS_DIR, { recursive: true });
}

async function cleanupLogsDir(): Promise<void> {
  await rm(TEST_LOGS_DIR, { recursive: true, force: true });
}

async function withMutedStdout<T>(run: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write;
  process.stdout.write = ((...args: unknown[]) => {
    const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === 'function');
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    return await run();
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function writeAndReadLog(
  workspaceId: string,
  run: (logger: Logger) => void | Promise<void>,
): Promise<string> {
  const logger = new Logger(TEST_LOGS_DIR, { workspaceId });

  try {
    await withMutedStdout(async () => {
      await run(logger);
    });
  } finally {
    await logger.close();
  }

  return readFile(logger.logFile, 'utf-8');
}

function countOccurrences(text: string, substring: string): number {
  return text.split(substring).length - 1;
}

async function testMatchedRulesLineIsWritten(): Promise<void> {
  const logText = await writeAndReadLog('rules-matched', (logger) => {
    logger.logToolResult(
      'read_file',
      successResult(),
      12,
      resultLogContext(metadata({
        rulesConfigured: true,
        matchedRuleLocations: ['rules.requestHeaders[0]'],
        enabledFeatures: ['structuredContentDup'],
      })),
    );
  });

  assertIncludes(
    logText,
    'Rules: matched rules.requestHeaders[0]; enabled structuredContentDup',
    'Matched request header rules should be logged with relative rule location and enabled feature',
  );
}

async function testNoMatchRulesLineIsWritten(): Promise<void> {
  const logText = await writeAndReadLog('rules-no-match', (logger) => {
    logger.logToolResult(
      'read_file',
      successResult(),
      12,
      resultLogContext(metadata({ rulesConfigured: true })),
    );
  });

  assertIncludes(logText, 'Rules: no match', 'Configured request header rules should log no match when no rule matches');
}

async function testUnconfiguredRulesDoNotWriteRulesLine(): Promise<void> {
  const logText = await writeAndReadLog('rules-unconfigured', (logger) => {
    logger.logToolResult(
      'read_file',
      successResult(),
      12,
      resultLogContext(metadata({ rulesConfigured: false })),
    );
  });

  assertNotIncludes(logText, 'Rules:', 'Unconfigured request header rules should not write a Rules line');
}

async function testSuccessAndFailureBothWriteRulesLine(): Promise<void> {
  const logText = await writeAndReadLog('rules-success-failure', (logger) => {
    const noMatchMetadata = metadata({ rulesConfigured: true });

    logger.logToolResult(
      'ok_tool',
      successResult('ok'),
      1,
      resultLogContext(noMatchMetadata, 'call_ok'),
    );
    logger.logToolResult(
      'fail_tool',
      errorResult('fail'),
      2,
      resultLogContext(noMatchMetadata, 'call_fail'),
    );
  });

  assertIncludes(logText, '→ OK ok_tool (1ms)', 'Successful result should be logged');
  assertIncludes(logText, '→ FAIL fail_tool (2ms)', 'Failed result should be logged');
  assertEqual(countOccurrences(logText, 'Rules: no match'), 2, 'Both success and failure results should include Rules metadata');
}

async function testFileLogDoesNotContainAnsiEscapeCodes(): Promise<void> {
  const logText = await writeAndReadLog('rules-no-ansi', (logger) => {
    logger.logToolResult(
      'read_file',
      successResult(),
      12,
      resultLogContext(metadata({
        rulesConfigured: true,
        matchedRuleLocations: ['rules.requestHeaders[0]'],
        enabledFeatures: ['structuredContentDup'],
      })),
    );
  });

  assert(!ANSI_ESCAPE_RE.test(logText), 'File log should remain plain text without ANSI escape codes');
}

async function testRulesLogDoesNotContainHeaderNamesOrValues(): Promise<void> {
  const requestHeaderName = 'X-Secret-Client';
  const configHeaderName = 'x-secret-client';
  const requestHeaderValue = 'request-secret-value';
  const configExpectedValue = 'config-secret-value';

  const logText = await writeAndReadLog('rules-privacy', (logger) => {
    logger.logToolResult(
      'read_file',
      successResult('safe result'),
      12,
      resultLogContext(metadata({
        rulesConfigured: true,
        matchedRuleLocations: ['rules.requestHeaders[0]'],
        enabledFeatures: ['structuredContentDup'],
      })),
    );
  });

  assertIncludes(logText, 'Rules: matched rules.requestHeaders[0]; enabled structuredContentDup', 'Privacy test should exercise matched rules logging');
  assertNotIncludes(logText, requestHeaderName, 'Rules log should not contain request header names');
  assertNotIncludes(logText, configHeaderName, 'Rules log should not contain config header names');
  assertNotIncludes(logText, requestHeaderValue, 'Rules log should not contain request header values');
  assertNotIncludes(logText, configExpectedValue, 'Rules log should not contain config expected header values');
}

async function testStructuredContentProtocolFieldIsNotLogged(): Promise<void> {
  const logText = await writeAndReadLog('rules-structured-content', (logger) => {
    logger.logToolResult(
      'read_file',
      {
        ...successResult('safe result text'),
        structuredContent: {
          payloadSecret: 'payload-secret',
          staleProtocolField: 'stale-protocol-field',
        },
      },
      12,
      resultLogContext(metadata({
        rulesConfigured: true,
        matchedRuleLocations: ['rules.requestHeaders[0]'],
        enabledFeatures: ['structuredContentDup'],
      })),
    );
  });

  assertIncludes(logText, 'safe result text', 'Logger should keep standard content text');
  assertIncludes(logText, 'Rules: matched rules.requestHeaders[0]; enabled structuredContentDup', 'Logger should keep Rules metadata');
  assertNotIncludes(logText, '"structuredContent"', 'Logger should not serialize the protocol structuredContent field');
  assertNotIncludes(logText, 'payload-secret', 'Logger should not log object structuredContent payload values');
  assertNotIncludes(logText, 'stale-protocol-field', 'Logger should not log stale handler structuredContent values');
}

async function testMixedImageContentIsLoggedInOrder(): Promise<void> {
  const firstImage = 'Zmlyc3QtaW1hZ2U=';
  const secondImage = 'c2Vjb25kLWltYWdl';
  const logText = await writeAndReadLog('mixed-image-content', (logger) => {
    logger.logToolResult(
      'image_tool',
      {
        content: [
          { type: 'text', text: 'before image' },
          { type: 'image', data: firstImage, mimeType: 'image/png' },
          { type: 'image', data: secondImage, mimeType: 'image/webp' },
          { type: 'text', text: 'after images' },
        ],
        structuredContent: {
          content: [{ type: 'image', data: firstImage, mimeType: 'image/png' }],
        },
        _meta: { 'example.com/private': 'metadata-secret' },
        isError: false,
      },
      12,
      resultLogContext(metadata({
        rulesConfigured: true,
        matchedRuleLocations: ['rules.requestHeaders[0]'],
        enabledFeatures: ['structuredContentDup'],
      })),
    );
  });

  const expectedBody = [
    '  before image',
    '  [image image/png]',
    `  ${firstImage}`,
    '  [image image/webp]',
    `  ${secondImage}`,
    '  after images',
  ].join('\n');
  assertIncludes(logText, expectedBody, 'Logger should preserve mixed content order and full image data');
  assertEqual(countOccurrences(logText, firstImage), 1, 'structuredContentDup should not duplicate image data in RESULT logs');
  assertNotIncludes(logText, 'metadata-secret', 'Logger should not serialize top-level metadata');
}

async function testImageOnlyResultHasBody(): Promise<void> {
  const imageData = 'cHVyZS1pbWFnZQ==';
  const logText = await writeAndReadLog('image-only-content', (logger) => {
    logger.logToolResult(
      'image_tool',
      {
        content: [{ type: 'image', data: imageData, mimeType: 'image/jpeg' }],
        isError: true,
      },
      1,
      resultLogContext(metadata({ rulesConfigured: false })),
    );
  });

  assertIncludes(logText, '→ FAIL image_tool (1ms)', 'Image-only errors should retain failure status');
  assertIncludes(logText, `  [image image/jpeg]\n  ${imageData}`, 'Image-only results should have a non-empty log body');
}

async function testToolCallIdentityIsWrittenForCallAndResult(): Promise<void> {
  const context: ToolCallResultLogContext = {
    sessionId: 'session_identity_test',
    callId: 'call_identity_test',
    requestHeaderPolicy: metadata({ rulesConfigured: false }),
  };
  const logText = await writeAndReadLog('tool-call-identity', (logger) => {
    logger.logToolCall('read_file', { file_path: 'src/index.ts' }, context);
    logger.logToolResult('read_file', successResult(), 12, context);
  });

  assertEqual(
    countOccurrences(logText, 'Session: session_identity_test'),
    2,
    'CALL and RESULT should include the same session ID',
  );
  assertEqual(
    countOccurrences(logText, 'Call ID: call_identity_test'),
    2,
    'CALL and RESULT should include the same call ID',
  );
}

async function testMissingSessionIsExplicitlyWritten(): Promise<void> {
  const context: ToolCallResultLogContext = {
    sessionId: undefined,
    callId: 'call_missing_session_test',
    requestHeaderPolicy: metadata({ rulesConfigured: false }),
  };
  const logText = await writeAndReadLog('missing-session', (logger) => {
    logger.logToolCall('read_file', {}, context);
    logger.logToolResult('read_file', successResult(), 12, context);
  });

  assertEqual(
    countOccurrences(logText, 'Session: unavailable (session ID missing)'),
    2,
    'CALL and RESULT should explicitly report a missing session ID',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing request header rules response logging',
    beforeAll: prepareLogsDir,
    afterAll: cleanupLogsDir,
    tests: [
      { name: 'matched rules line is written', run: testMatchedRulesLineIsWritten },
      { name: 'no-match rules line is written', run: testNoMatchRulesLineIsWritten },
      { name: 'unconfigured rules do not write Rules line', run: testUnconfiguredRulesDoNotWriteRulesLine },
      { name: 'success and failure both write Rules line', run: testSuccessAndFailureBothWriteRulesLine },
      { name: 'file log does not contain ANSI escape codes', run: testFileLogDoesNotContainAnsiEscapeCodes },
      { name: 'rules log does not contain header names or values', run: testRulesLogDoesNotContainHeaderNamesOrValues },
      { name: 'structuredContent protocol field is not logged', run: testStructuredContentProtocolFieldIsNotLogged },
      { name: 'mixed image content is logged in order', run: testMixedImageContentIsLoggedInOrder },
      { name: 'image-only result has a log body', run: testImageOnlyResultHasBody },
      { name: 'tool call identity is written for call and result', run: testToolCallIdentityIsWrittenForCallAndResult },
      { name: 'missing session is explicitly written', run: testMissingSessionIsExplicitlyWritten },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

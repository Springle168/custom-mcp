import {
  readEnvPositiveInteger,
  readFreeFormString,
  readIpAddress,
  readJsonPositiveInteger,
  readLineEndingToken,
  readSelectorToken,
  readTypedString,
  readWorkspaceIdToken,
  type ValuePolicyResult,
} from '../../src/config/value-policy.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

function expectOk<T>(result: ValuePolicyResult<T>, message: string): T {
  if (!result.ok) {
    throw new Error(`${message}: ${result.error.message}`);
  }

  return result.value;
}

function expectError<T>(
  result: ValuePolicyResult<T>,
  expectedMessage: string,
  message: string,
): void {
  assert(!result.ok, `${message}: expected an error`);
  assertIncludes(result.error.message, expectedMessage, message);
}

function testTypedStringWhitespacePriority(): void {
  expectError(
    readTypedString(42, { fieldPath: 'field' }),
    'field must be a string',
    'Non-string values should fail before string whitespace checks',
  );
  expectError(
    readTypedString('', { fieldPath: 'field' }),
    'field must be a non-empty string',
    'Empty strings should use the non-empty message',
  );
  expectError(
    readTypedString('   ', { fieldPath: 'field' }),
    'field must be a non-empty string',
    'Whitespace-only strings should use the non-empty message',
  );
  expectError(
    readTypedString(' value', { fieldPath: 'field' }),
    'field must not contain leading or trailing whitespace',
    'Leading whitespace should fail before grammar checks',
  );
  expectError(
    readTypedString('value ', { fieldPath: 'field' }),
    'field must not contain leading or trailing whitespace',
    'Trailing whitespace should fail before grammar checks',
  );
  expectError(
    readTypedString('\tvalue\n', { fieldPath: 'field' }),
    'field must not contain leading or trailing whitespace',
    'ECMAScript trim whitespace should be rejected at typed string boundaries',
  );

  assertEqual(
    expectOk(readTypedString('value with internal spaces', { fieldPath: 'field' }), 'Internal spaces should be preserved'),
    'value with internal spaces',
    'Typed strings should preserve the original legal value',
  );
}

function testTokenGrammar(): void {
  assertEqual(
    expectOk(readWorkspaceIdToken('workspace_0', { fieldPath: 'workspace.id' }), 'Valid workspace id should parse'),
    'workspace_0',
    'Workspace id should be returned unchanged',
  );
  expectError(
    readWorkspaceIdToken(' Workspace_0', { fieldPath: 'workspace.id' }),
    'must not contain leading or trailing whitespace',
    'Workspace id leading whitespace should not fall through to grammar',
  );
  expectError(
    readWorkspaceIdToken('Workspace_0', { fieldPath: 'workspace.id' }),
    'must be 1-64 characters',
    'Workspace id grammar should reject uppercase tokens',
  );

  assertEqual(
    expectOk(readLineEndingToken('crlf', { fieldPath: 'lineEnding' }), 'Valid lineEnding should parse'),
    'crlf',
    'lineEnding should preserve the exact token',
  );
  expectError(
    readLineEndingToken('CRLF', { fieldPath: 'lineEnding' }),
    'must be one of: auto, lf, crlf',
    'lineEnding should be case-sensitive',
  );
}

function testIpAddress(): void {
  for (const value of ['127.0.0.1', '192.168.1.10', '::1', '2001:db8::1']) {
    assertEqual(
      expectOk(readIpAddress(value, { fieldPath: 'host' }), `IP address ${value} should parse`),
      value,
      'IP address reader should preserve the original legal value',
    );
  }

  for (const value of ['localhost', 'example.com', '127.0.0.1:3100', '999.1.1.1']) {
    expectError(
      readIpAddress(value, { fieldPath: 'host' }),
      'host must be an IPv4 or IPv6 address',
      `Invalid IP address ${JSON.stringify(value)} should fail`,
    );
  }

  expectError(
    readIpAddress(' 127.0.0.1', { fieldPath: 'host' }),
    'must not contain leading or trailing whitespace',
    'IP address validation should preserve typed string whitespace priority',
  );
}

function testSelectorTokenBoundary(): void {
  assertEqual(
    expectOk(
      readSelectorToken('android.javaHome', { fieldPath: 'envOverrides.allowedFields[0]' }),
      'Selector token should parse',
    ),
    'android.javaHome',
    'Selector reader should preserve the original legal selector',
  );
  expectError(
    readSelectorToken('logsDir ', { fieldPath: 'envOverrides.allowedFields[0]' }),
    'must not contain leading or trailing whitespace',
    'Selector reader should reject trailing whitespace before domain checks',
  );
  expectError(
    readSelectorToken('rootDir', {
      fieldPath: 'envOverrides.allowedFields[0]',
      allowedValues: ['logsDir'],
      description: 'one of: logsDir',
    }),
    'must be one of: logsDir',
    'Selector reader should support exact allowed selector sets',
  );
}

function testJsonPositiveInteger(): void {
  assertEqual(
    expectOk(
      readJsonPositiveInteger(3100, {
        fieldPath: 'port',
        max: 65535,
        rangeDescription: 'between 1 and 65535',
      }),
      'JSON number positive integer should parse',
    ),
    3100,
    'JSON number should be returned as a number',
  );

  for (const value of ['3100', ' 3100', '3100 ']) {
    expectError(
      readJsonPositiveInteger(value, {
        fieldPath: 'port',
        max: 65535,
        rangeDescription: 'between 1 and 65535',
      }),
      'port must be a JSON number positive integer between 1 and 65535',
      `Numeric string ${JSON.stringify(value)} should not be parsed as a typed string`,
    );
  }

  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 65536]) {
    expectError(
      readJsonPositiveInteger(value, {
        fieldPath: 'port',
        max: 65535,
        rangeDescription: 'between 1 and 65535',
      }),
      'port must be a JSON number positive integer between 1 and 65535',
      `Invalid JSON number ${String(value)} should fail positive integer rules`,
    );
  }
}

function testEnvPositiveInteger(): void {
  assertEqual(
    expectOk(readEnvPositiveInteger('1234', { fieldPath: 'ANDROID_BUILD_TIMEOUT_MS' }), 'Env positive integer should parse'),
    1234,
    'Env positive integer should return a number',
  );

  expectError(
    readEnvPositiveInteger('', { fieldPath: 'ANDROID_BUILD_TIMEOUT_MS' }),
    'ANDROID_BUILD_TIMEOUT_MS must be a non-empty string',
    'Empty env values should be invalid values, not absence',
  );
  expectError(
    readEnvPositiveInteger(' 1234', { fieldPath: 'ANDROID_BUILD_TIMEOUT_MS' }),
    'ANDROID_BUILD_TIMEOUT_MS must not contain leading or trailing whitespace',
    'Env numbers should not be trimmed before grammar checks',
  );

  for (const value of ['001', '+123', '1.5', '123abc']) {
    expectError(
      readEnvPositiveInteger(value, { fieldPath: 'ANDROID_BUILD_TIMEOUT_MS' }),
      'ANDROID_BUILD_TIMEOUT_MS must be a positive integer',
      `Env numeric grammar should reject ${JSON.stringify(value)}`,
    );
  }
}

function testFreeFormStringPreservesWhitespace(): void {
  assertEqual(
    expectOk(readFreeFormString('  literal text  ', { fieldPath: 'prompt' }), 'Free-form strings should parse'),
    '  literal text  ',
    'Free-form strings should preserve leading and trailing whitespace',
  );
  assertEqual(
    expectOk(readFreeFormString('', { fieldPath: 'prompt' }), 'Free-form strings may allow empty content by default'),
    '',
    'Free-form empty strings should be controlled by the caller',
  );
  expectError(
    readFreeFormString('', { fieldPath: 'prompt', allowEmpty: false }),
    'prompt must be a non-empty string',
    'Free-form callers can opt out of empty strings',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing config value policy readers',
    tests: [
      { name: 'typed string whitespace priority', run: testTypedStringWhitespacePriority },
      { name: 'token grammar', run: testTokenGrammar },
      { name: 'IP address', run: testIpAddress },
      { name: 'selector token boundary', run: testSelectorTokenBoundary },
      { name: 'JSON positive integer', run: testJsonPositiveInteger },
      { name: 'env positive integer', run: testEnvPositiveInteger },
      { name: 'free-form string preserves whitespace', run: testFreeFormStringPreservesWhitespace },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

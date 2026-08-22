import type { ExternalRoutingSpec } from '../../src/tools/external-routing/config.js';
import {
  formatExternalRoutingStartupLines,
  formatFileAccessPolicyStartupLines,
} from '../../src/runtime/startup-logging.js';
import {
  assertEqual,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

function externalRoute(
  endpointUrl = 'https://route-user:route-password@external.example.test:8443/tool?access=redacted-query',
): ExternalRoutingSpec {
  return {
    processorConfigFilePath: 'C:\\RouteConfig\\processor.json',
    httpEndpointConfigFilePath: 'C:\\RouteConfig\\endpoint.json',
    endpoint: {
      url: endpointUrl,
      timeoutMs: 30_000,
      headers: { Authorization: 'header-value-not-for-startup' },
    },
    processors: [{
      name: 'body-codec',
      executable: {
        resolution: 'absolute-path',
        path: 'C:\\RouteProcessors\\body-codec.exe',
      },
      arguments: ['--processor-argument-not-for-startup'],
      workingDirectory: 'C:\\RouteProcessors',
      timeoutMs: 30_000,
    }],
    requestStrategy: {
      strategy: 'request-to-external',
      mode: 'body-encoder',
      processor: 'body-codec',
      contentType: 'application/octet-stream',
    },
    responseStrategy: {
      strategy: 'response-from-external',
      mode: 'body-decoder',
      processor: 'body-codec',
    },
  };
}

function testFormatsExternalRoutingStartupSummary(): void {
  const summary = formatExternalRoutingStartupLines(externalRoute()).join('\n');

  assertEqual(
    summary,
    [
      '  External routing: enabled',
      '    Request mode: body-encoder',
      '    Response mode: body-decoder',
      '    Endpoint: https://external.example.test:8443/tool',
    ].join('\n'),
    'External routing startup logging should include only status, modes, and a scrubbed endpoint identity',
  );
  for (const excludedValue of [
    'route-user',
    'route-password',
    'redacted-query',
    'header-value-not-for-startup',
    'C:\\RouteConfig\\processor.json',
    'C:\\RouteProcessors\\body-codec.exe',
    '--processor-argument-not-for-startup',
  ]) {
    assertNotIncludes(
      summary,
      excludedValue,
      `External routing startup summary must not include ${excludedValue}`,
    );
  }
}

function testFormatsDisabledExternalRouting(): void {
  assertEqual(
    formatExternalRoutingStartupLines(undefined).join('\n'),
    '  External routing: disabled',
    'Missing external routing should be explicitly identified as disabled',
  );
}

function testDoesNotExposeMalformedEndpointInput(): void {
  const summary = formatExternalRoutingStartupLines(externalRoute('not a valid endpoint')).join('\n');

  assertEqual(
    summary,
    [
      '  External routing: enabled',
      '    Request mode: body-encoder',
      '    Response mode: body-decoder',
      '    Endpoint: unavailable',
    ].join('\n'),
    'Malformed endpoint input should use a safe fallback rather than the raw value',
  );
  assertNotIncludes(
    summary,
    'not a valid endpoint',
    'Malformed endpoint input must not be copied into startup logs',
  );
}

function testFormatsRootSpecificPolicyFiles(): void {
  const lines = formatFileAccessPolicyStartupLines([
    {
      rootDir: 'E:\\Workspace',
      ignoreFiles: [
        'C:\\Policies\\base.ignore',
        'C:\\Policies\\base.ignore',
      ],
      denyFiles: ['C:\\Policies\\project.deny'],
    },
    {
      rootDir: 'E:\\Additional',
      ignoreFiles: [],
      denyFiles: ['C:\\Policies\\additional.deny'],
    },
  ]);

  assertEqual(
    lines.join('\n'),
    [
      '  File access policies:',
      '    Primary root: E:\\Workspace',
      '      Ignore files:',
      '        - C:\\Policies\\base.ignore',
      '        - C:\\Policies\\base.ignore',
      '      Deny files:',
      '        - C:\\Policies\\project.deny',
      '    Additional root: E:\\Additional',
      '      Ignore files: none',
      '      Deny files:',
      '        - C:\\Policies\\additional.deny',
    ].join('\n'),
    'Startup policy logging should preserve root association, order, and duplicates',
  );
}

function testFormatsEmptyPolicyState(): void {
  const lines = formatFileAccessPolicyStartupLines([
    {
      rootDir: 'E:\\Workspace',
      ignoreFiles: [],
      denyFiles: [],
    },
  ]);

  assertEqual(
    lines.join('\n'),
    '  File access policies: none',
    'Startup policy logging should explicitly identify an empty policy configuration',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing startup logging',
    tests: [
      {
        name: 'formats safe external routing summary',
        run: testFormatsExternalRoutingStartupSummary,
      },
      {
        name: 'formats disabled external routing',
        run: testFormatsDisabledExternalRouting,
      },
      {
        name: 'does not expose malformed external endpoint input',
        run: testDoesNotExposeMalformedEndpointInput,
      },
      {
        name: 'formats root-specific policy files',
        run: testFormatsRootSpecificPolicyFiles,
      },
      {
        name: 'formats empty policy state',
        run: testFormatsEmptyPolicyState,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

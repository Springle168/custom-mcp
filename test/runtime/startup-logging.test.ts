import { formatFileAccessPolicyStartupLines } from '../../src/runtime/startup-logging.js';
import { assertEqual, runTestSuite } from '../test-utils.js';

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

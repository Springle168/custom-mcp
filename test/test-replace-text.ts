import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import type { ToolCallResult } from '../src/tools/types.js';
import replaceTool from '../src/tools/replace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'replace-text');

const testConfig: Config = {
  rootDir: FIXTURES_DIR,
  lineEnding: 'auto',
  port: 3100,
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertIncludes(text: string, substring: string, message: string): void {
  if (!text.includes(substring)) {
    throw new Error(
      `Assertion failed: ${message}\nExpected to find: "${substring}"\nIn text: ${text.substring(0, 200)}...`,
    );
  }
}

function assertNotIncludes(
  text: string,
  substring: string,
  message: string,
): void {
  if (text.includes(substring)) {
    throw new Error(
      `Assertion failed: ${message}\nDid not expect to find: "${substring}"\nIn text: ${text.substring(0, 200)}...`,
    );
  }
}

function assertEquals(actual: string, expected: string, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
    );
  }
}

function getResultText(result: ToolCallResult): string {
  return result.content[0]?.text ?? '';
}

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function testWarnsButWritesPlaceholderReplacement(): Promise<void> {
  console.log('Test: Warns but writes possible placeholder replacement');

  const targetPath = path.join(FIXTURES_DIR, 'warns.ts');
  await fs.writeFile(targetPath, 'function demo() {\n  return 1;\n}\n', 'utf-8');

  const result = await replaceTool.handler(
    {
      file_path: 'warns.ts',
      old_string: '  return 1;',
      new_string: '  // ...\n  return 2;',
    },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);
  assertIncludes(text, 'Warning:', 'Should include a warning');
  assertIncludes(text, "'...'", 'Should name the placeholder');

  const raw = await fs.readFile(targetPath, 'utf-8');
  assertEquals(
    raw,
    'function demo() {\n  // ...\n  return 2;\n}\n',
    'Should still write the requested replacement',
  );

  console.log('  ✓ Passed\n');
}

async function testDoesNotWarnForExistingPlaceholder(): Promise<void> {
  console.log('Test: Does not warn for placeholder already in old_string');

  const targetPath = path.join(FIXTURES_DIR, 'existing-placeholder.txt');
  await fs.writeFile(targetPath, 'before\n// ...\nafter\n', 'utf-8');

  const result = await replaceTool.handler(
    {
      file_path: 'existing-placeholder.txt',
      old_string: '// ...',
      new_string: '// ...\nactual content',
    },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  assertNotIncludes(
    getResultText(result),
    'Warning:',
    'Should not warn when the same placeholder already existed',
  );

  const raw = await fs.readFile(targetPath, 'utf-8');
  assertEquals(
    raw,
    'before\n// ...\nactual content\nafter\n',
    'Should write the replacement without warning',
  );

  console.log('  ✓ Passed\n');
}

async function testRejectsNonBooleanAllowMultiple(): Promise<void> {
  console.log('Test: Rejects non-boolean allow_multiple');

  const result = await replaceTool.handler(
    {
      file_path: 'unused.txt',
      old_string: 'old',
      new_string: 'new',
      allow_multiple: 'false',
    },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  assertIncludes(
    getResultText(result),
    "The 'allow_multiple' parameter must be a boolean when provided.",
    'Should explain boolean requirement',
  );

  console.log('  ✓ Passed\n');
}

async function main(): Promise<void> {
  console.log('='.repeat(24));
  console.log('Testing replace_text tool');
  console.log('='.repeat(24));
  console.log(`Fixtures directory: ${FIXTURES_DIR}\n`);

  await prepareFixtures();

  const tests = [
    testWarnsButWritesPlaceholderReplacement,
    testDoesNotWarnForExistingPlaceholder,
    testRejectsNonBooleanAllowMultiple,
  ];

  let passed = 0;
  let failed = 0;

  try {
    for (const test of tests) {
      try {
        await test();
        passed++;
      } catch (error) {
        failed++;
        console.error(
          `  ✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  } finally {
    await cleanupFixtures();
  }

  console.log('='.repeat(24));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(24));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

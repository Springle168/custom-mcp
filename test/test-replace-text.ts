import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import replaceTool from '../src/tools/replace.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  getResultText,
  runTestSuite,
} from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'replace-text');

const testConfig: Config = {
  rootDir: FIXTURES_DIR,
  lineEnding: 'auto',
  port: 3100,
};

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function testWarnsButWritesPlaceholderReplacement(): Promise<void> {
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
  assertEqual(
    raw,
    'function demo() {\n  // ...\n  return 2;\n}\n',
    'Should still write the requested replacement',
  );
}

async function testDoesNotWarnForExistingPlaceholder(): Promise<void> {
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
  assertEqual(
    raw,
    'before\n// ...\nactual content\nafter\n',
    'Should write the replacement without warning',
  );
}

async function testRejectsNonBooleanAllowMultiple(): Promise<void> {
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
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing replace_text tool',
    details: `Fixtures directory: ${FIXTURES_DIR}`,
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'Warns but writes possible placeholder replacement',
        run: testWarnsButWritesPlaceholderReplacement,
      },
      {
        name: 'Does not warn for placeholder already in old_string',
        run: testDoesNotWarnForExistingPlaceholder,
      },
      {
        name: 'Rejects non-boolean allow_multiple',
        run: testRejectsNonBooleanAllowMultiple,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

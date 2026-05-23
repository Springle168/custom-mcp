import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import replaceTool from '../src/tools/replace.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  getResultText,
  runTestSuite,
} from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'replace-text');

const testConfig: Config = {
  rootDir: FIXTURES_DIR,
  otherRootDirs: [],
  lineEnding: 'auto',
  port: 3100,
};

interface ReplaceJsonPayload {
  success: boolean;
  note?: string;
  allow_multiple: boolean;
  matched_targets: number;
  replacement_count: number;
  matched_span: { start_line: number; end_line: number } | null;
  file_line_count: { previous: number; current: number };
}

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.rm(path.join(__dirname, 'fixtures', 'replace-text-other-root'), {
    recursive: true,
    force: true,
  });
}

function parsePayload(result: { content?: Array<{ text?: string }> }): ReplaceJsonPayload {
  return JSON.parse(getResultText(result)) as ReplaceJsonPayload;
}

async function testWarnsButWritesPlaceholderReplacement(): Promise<void> {
  const targetPath = path.join(FIXTURES_DIR, 'warns.ts');
  await fs.writeFile(targetPath, 'function demo() {\n  return 1;\n}\n', 'utf-8');

  const result = await replaceTool.handler(
    {
      file_path: 'warns.ts',
      target: '  return 1;',
      replacement: '  // ...\n  return 2;',
    },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const payload = parsePayload(result);
  assert(payload.success, 'Payload should report success');
  assertIncludes(payload.note, 'Warning:', 'Should include a warning');
  assertIncludes(payload.note, "'...'", 'Should name the placeholder');
  assertEqual(payload.matched_targets, 1, 'Should report one matched target');
  assertEqual(payload.replacement_count, 1, 'Should report one replacement');
  assertEqual(
    payload.matched_span?.start_line,
    2,
    'Should report matched start line',
  );

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
      target: '// ...',
      replacement: '// ...\nactual content',
    },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const payload = parsePayload(result);
  assert(payload.success, 'Payload should report success');
  assertEqual(payload.note, undefined, 'Should not warn for existing placeholder');

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
      target: 'old',
      replacement: 'new',
      allow_multiple: 'false',
    },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  const payload = parsePayload(result);
  assert(!payload.success, 'Payload should report failure');
  assertEqual(payload.allow_multiple, false, 'Invalid allow_multiple should normalize to false');
}

async function testRejectsOldFieldAliases(): Promise<void> {
  const targetPath = path.join(FIXTURES_DIR, 'old-fields.txt');
  await fs.writeFile(targetPath, 'old\n', 'utf-8');

  const result = await replaceTool.handler(
    {
      file_path: 'old-fields.txt',
      old_string: 'old',
      new_string: 'new',
    },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  const text = getResultText(result);
  assertIncludes(text, 'old_string', 'Should mention rejected old field');
  assertIncludes(text, 'target/replacement', 'Should suggest v2 parameter names');

  const raw = await fs.readFile(targetPath, 'utf-8');
  assertEqual(raw, 'old\n', 'Should not modify the file');
}

async function testReplaceAbsolutePathInOtherRootDir(): Promise<void> {
  const otherRootDir = path.join(__dirname, 'fixtures', 'replace-text-other-root');
  const targetPath = path.join(otherRootDir, 'other.ts');
  const traversalPath = path.join('..', 'replace-text-other-root', 'other.ts');
  const config: Config = {
    ...testConfig,
    otherRootDirs: [otherRootDir],
  };

  await fs.mkdir(otherRootDir, { recursive: true });
  await fs.writeFile(targetPath, 'export const value = 1;\n', 'utf-8');

  const driveRelativeResult = await replaceTool.handler(
    {
      file_path: 'C:other.ts',
      target: 'value = 1',
      replacement: 'value = 9',
    },
    config,
  );
  assert(driveRelativeResult.isError === true, 'Drive-relative path should fail');
  assertIncludes(
    getResultText(driveRelativeResult),
    'Drive-relative paths',
    'Should reject drive-relative paths',
  );

  if (process.platform === 'win32') {
    const rootedResult = await replaceTool.handler(
      {
        file_path: '/replace-text-other-root/other.ts',
        target: 'value = 1',
        replacement: 'value = 9',
      },
      config,
    );
    assert(rootedResult.isError === true, 'Windows rooted path should fail');
    assertIncludes(
      getResultText(rootedResult),
      'Windows rooted paths without a drive',
      'Should reject Windows rooted paths without a drive',
    );
  }

  const traversalResult = await replaceTool.handler(
    {
      file_path: traversalPath,
      target: 'value = 1',
      replacement: 'value = 9',
    },
    config,
  );
  assert(traversalResult.isError === true, 'Relative traversal should not reach otherRootDirs');
  assertIncludes(
    getResultText(traversalResult),
    'outside the allowed workspace',
    'Should reject relative traversal into otherRootDirs',
  );

  const result = await replaceTool.handler(
    {
      file_path: targetPath,
      target: 'value = 1',
      replacement: 'value = 2',
    },
    config,
  );

  assert(result.isError !== true, 'Should succeed');
  const payload = parsePayload(result);
  assert(payload.success, 'Payload should report success');
  assertEqual(payload.replacement_count, 1, 'Should replace in otherRootDirs');
  const raw = await fs.readFile(targetPath, 'utf-8');
  assertEqual(raw, 'export const value = 2;\n', 'Should update the other-root file');
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
        name: 'Does not warn for placeholder already in target',
        run: testDoesNotWarnForExistingPlaceholder,
      },
      {
        name: 'Rejects non-boolean allow_multiple',
        run: testRejectsNonBooleanAllowMultiple,
      },
      {
        name: 'Rejects old field aliases',
        run: testRejectsOldFieldAliases,
      },
      {
        name: 'Replaces absolute path in otherRootDirs',
        run: testReplaceAbsolutePathInOtherRootDir,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

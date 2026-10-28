import * as fs from 'node:fs/promises';
import mutableFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import readTool from '../../src/tools/built-in/files/read.js';
import replaceTool from '../../src/tools/built-in/files/replace.js';
import writeFileTool from '../../src/tools/built-in/files/write-file.js';
import {
  expandFileAccessGlob,
  resolveFileAccessPath,
  validateFileAccessReadTarget,
  validateFileAccessWriteTarget,
} from '../../src/utils/file-access-policy.js';
import { readTextFile } from '../../src/utils/file-read.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/file-system-errors/', import.meta.url));
const DIRECTORY = path.join(FIXTURES_DIR, 'nested');
const TARGET = path.join(DIRECTORY, 'existing.txt');
const DISPLAY_PATH = 'nested/existing.txt';
const PRIVATE_DETAILS = [
  'private-message',
  'private-real-path',
  'private-destination',
  'private-syscall',
  'private-stack',
] as const;

type FsMethod = 'realpath' | 'stat' | 'lstat' | 'readFile' | 'mkdir' | 'writeFile';

function injectedError(code: string) {
  return Object.assign(new Error(PRIVATE_DETAILS[0]), {
    code,
    path: PRIVATE_DETAILS[1],
    dest: PRIVATE_DETAILS[2],
    syscall: PRIVATE_DETAILS[3],
    stack: PRIVATE_DETAILS[4],
  });
}

function assertPrivate(text: string): void {
  for (const detail of PRIVATE_DETAILS) {
    assertNotIncludes(text, detail, 'OS exception metadata must not enter public results');
  }
  assertNotIncludes(text, FIXTURES_DIR, 'Relative requests must not disclose the implicit root');
}

async function withFailure(
  method: FsMethod,
  target: string,
  error: unknown,
  run: () => Promise<void>,
  occurrence = 1,
): Promise<void> {
  const original = mutableFs[method];
  let matches = 0;
  let failures = 0;
  const replacement = mock.method(mutableFs, method, async (...args: unknown[]) => {
    if (String(args[0]) === target && ++matches === occurrence) {
      failures++;
      throw error;
    }
    return Reflect.apply(original, mutableFs, args);
  });
  syncBuiltinESMExports();
  try {
    await run();
    assertEqual(failures, 1, `${method}: exercise the intended failure boundary`);
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
}

async function prepareFixtures(): Promise<void> {
  await fs.mkdir(DIRECTORY, { recursive: true });
  await fs.writeFile(TARGET, 'alpha\nbeta');
}

async function testReadPolicyFailures(): Promise<void> {
  const context = createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
  const safe = resolveFileAccessPath(DISPLAY_PATH, context.fileAccessPolicyContext);
  assert(safe.ok, 'Fixture path must pass lexical safety');
  for (const method of ['realpath', 'stat'] as const) {
    for (const [code, reason] of [
      ['EACCES', 'permission denied'],
      ['PRIVATE_UNKNOWN_CODE', 'file system operation failed'],
    ] as const) {
      await withFailure(method, TARGET, injectedError(code), async () => {
        const result = await validateFileAccessReadTarget(
          safe.path,
          context.fileAccessPolicyContext,
        );
        assert(!result.ok, `${method}: failed read validation`);
        assertEqual(result.code, 'io_error', 'Preserve policy result structure and code');
        assertIncludes(result.reason, reason, 'Controlled errno reason');
        assertPrivate(result.reason);
      });
    }
  }
}

async function testWritePolicyFailures(): Promise<void> {
  const context = createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
  const safe = resolveFileAccessPath(DISPLAY_PATH, context.fileAccessPolicyContext);
  assert(safe.ok, 'Fixture path must pass lexical safety');
  for (const [method, target] of [
    ['lstat', DIRECTORY],
    ['realpath', DIRECTORY],
    ['lstat', TARGET],
    ['realpath', TARGET],
    ['stat', TARGET],
  ] as const) {
    await withFailure(method, target, injectedError('EBUSY'), async () => {
      const result = await validateFileAccessWriteTarget(
        safe.path,
        context.fileAccessPolicyContext,
      );
      assert(!result.ok, `${method}: failed write validation`);
      assertEqual(result.code, 'io_error', 'Keep write validation result code');
      assertIncludes(result.reason, 'file or directory is busy', 'Controlled busy reason');
      assertPrivate(result.reason);
    });
  }
}

async function testGlobFailures(): Promise<void> {
  const context = createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
  for (const [method, occurrence] of [
    ['lstat', 1],
    ['realpath', 1],
    ['stat', 1],
    ['lstat', 2],
    ['realpath', 2],
  ] as const) {
    await withFailure(
      method,
      DIRECTORY,
      injectedError('EACCES'),
      async () => {
        const result = await expandFileAccessGlob(
          'nested/**/*.txt',
          context.fileAccessPolicyContext,
        );
        if (occurrence === 1) {
          assert(!result.ok, 'Static-base validation must fail explicitly');
          assertIncludes(result.reason, 'permission denied', 'Static base uses controlled reason');
        }

        // glob may suppress a readdir failure as no matches. Either result must
        // keep implicit traversal paths and exception metadata private.
        assertPrivate(JSON.stringify(result));
      },
      occurrence,
    );
  }

  await withFailure('realpath', TARGET, injectedError('EIO'), async () => {
    const result = await expandFileAccessGlob('nested/**/*.txt', context.fileAccessPolicyContext);
    assert(result.ok, 'A failed member does not fail the entire glob');
    assertEqual(result.expansion.skipped.length, 1, 'Failed member remains a skipped result');
    assertIncludes(
      result.expansion.skipped[0]?.reason,
      'input/output error',
      'Member errno mapping',
    );
    assertPrivate(JSON.stringify(result));
  });
}

async function testGlobParserFailure(): Promise<void> {
  const context = createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
  // This exceeds minimatch's pattern length limit, without relying on exception
  // text or inspecting dependency internals to recognize a parser failure.
  const result = await expandFileAccessGlob(
    `*${'a'.repeat(70_000)}`,
    context.fileAccessPolicyContext,
  );
  assert(!result.ok, 'An oversized pattern must return a controlled expansion failure');
  assertEqual(
    result.reason,
    'Glob pattern could not be expanded. Check that the include pattern is valid.',
    'Parser failure is fixed text',
  );
}

async function testReadContentFailures(): Promise<void> {
  for (const method of ['stat', 'readFile'] as const) {
    for (const error of [injectedError('ENOTDIR'), null]) {
      await withFailure(method, TARGET, error, async () => {
        const result = await readTextFile(TARGET, new AbortController().signal);
        assert(!result.ok, 'A failed source returns a local failure');
        assertEqual(
          result.reason,
          error === null ? 'file system operation failed' : 'a path component is not a directory',
          'Shared reason handles errno and non-Error throws',
        );
        assertPrivate(result.reason);
      });
    }
  }
}

async function testPublicToolFailures(): Promise<void> {
  const context = createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
  for (const [tool, args] of [
    [readTool, { include: [DISPLAY_PATH] }],
    [writeFileTool, { file_path: DISPLAY_PATH, content: 'changed' }],
    [
      replaceTool,
      {
        files: [
          { file_path: DISPLAY_PATH, replacements: [{ target: 'alpha', replacement: 'changed' }] },
        ],
      },
    ],
  ] as const) {
    await withFailure('readFile', TARGET, injectedError('EPERM'), async () => {
      const result = await tool.handler(args, context, createTestToolInvocationContext());
      assertEqual(result.isError, true, 'Public read/preparation failure remains an error');
      const text = getResultText(result);
      assertIncludes(text, 'permission denied', 'Public reason is errno-based');
      assertIncludes(text, 'existing.txt', 'Caller-visible path remains available');
      assertPrivate(text);
    });
  }
}

async function testWriteAndCreateFailures(): Promise<void> {
  const context = createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
  for (const tool of [writeFileTool, replaceTool]) {
    for (const create of [false, true]) {
      const file_path = create ? 'nested/missing.txt' : DISPLAY_PATH;
      const target = create ? path.join(DIRECTORY, 'missing.txt') : TARGET;
      const args =
        tool === writeFileTool
          ? { file_path, content: 'changed' }
          : {
              files: [
                {
                  file_path,
                  replacements: [{ target: create ? '' : 'alpha', replacement: 'changed' }],
                },
              ],
            };
      for (const method of ['mkdir', 'writeFile'] as const) {
        await withFailure(
          method,
          method === 'mkdir' ? DIRECTORY : target,
          injectedError('ENOSPC'),
          async () => {
            const result = await tool.handler(args, context, createTestToolInvocationContext());
            assertEqual(result.isError, true, 'Write/create failure remains an error');
            const text = getResultText(result);
            assertIncludes(
              text,
              'no space left on device',
              'Write failure uses controlled storage reason',
            );
            assertPrivate(text);
            if (tool === replaceTool && method === 'writeFile') {
              assertIncludes(
                text,
                'use read to verify',
                'Direct-write recovery warning is preserved',
              );
            }
          },
        );
      }
      assertEqual(
        await fs.readFile(TARGET, 'utf8'),
        'alpha\nbeta',
        'Injected failures leave fixture unchanged',
      );
    }
  }
}

await runTestSuite({
  title: 'File system error privacy across file tools',
  beforeAll: prepareFixtures,
  afterAll: async () => {
    await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  },
  tests: [
    { name: 'Read policy realpath and stat failures', run: testReadPolicyFailures },
    { name: 'Write policy ancestor and target failures', run: testWritePolicyFailures },
    { name: 'Glob static-base, traversal, and member failures', run: testGlobFailures },
    { name: 'Non-FS glob parser failures use fixed text', run: testGlobParserFailure },
    {
      name: 'Source reads share errno reasons and accept unknown thrown values',
      run: testReadContentFailures,
    },
    { name: 'Public tools keep read/preparation paths private', run: testPublicToolFailures },
    {
      name: 'Write/create failures preserve controlled reasons and recovery warning',
      run: testWriteAndCreateFailures,
    },
  ],
});

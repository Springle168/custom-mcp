import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  readStrictUtf8RegularFile,
  StrictUtf8FileError,
} from '../../src/config/strict-utf8-file.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'strict-utf8-file');
const TEXT_FILE = path.join(FIXTURES_DIR, 'text.txt');

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

function captureStrictFileError(run: () => unknown): StrictUtf8FileError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof StrictUtf8FileError, 'Expected a StrictUtf8FileError');
    return error;
  }
  throw new Error('Expected strict UTF-8 file reading to fail.');
}

async function testReadsRegularUtf8File(): Promise<void> {
  await resetFixtures();
  await fs.writeFile(TEXT_FILE, 'hello\n', 'utf-8');
  assertEqual(
    readStrictUtf8RegularFile(TEXT_FILE),
    'hello\n',
    'Regular UTF-8 text should be returned unchanged',
  );
}

async function testConsumesExactlyOneBom(): Promise<void> {
  await resetFixtures();
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await fs.writeFile(TEXT_FILE, Buffer.concat([bom, bom, Buffer.from('text')]));

  assertEqual(
    readStrictUtf8RegularFile(TEXT_FILE),
    '\uFEFFtext',
    'The decoder should consume one encoding BOM and preserve a second BOM as content',
  );
}

async function testClassifiesBoundaryFailures(): Promise<void> {
  await resetFixtures();

  assertEqual(
    captureStrictFileError(() => readStrictUtf8RegularFile(path.join(FIXTURES_DIR, 'missing.txt')))
      .reason,
    'not_found',
    'Missing targets should have a stable reason',
  );

  assertEqual(
    captureStrictFileError(() => readStrictUtf8RegularFile(FIXTURES_DIR)).reason,
    'not_regular',
    'Directories should not satisfy the regular-file boundary',
  );

  await fs.writeFile(TEXT_FILE, Buffer.from([0xc3, 0x28]));
  assertEqual(
    captureStrictFileError(() => readStrictUtf8RegularFile(TEXT_FILE)).reason,
    'invalid_utf8',
    'Malformed UTF-8 should fail closed',
  );
}

async function testFollowsSymlinkToRegularFile(): Promise<void> {
  await resetFixtures();
  await fs.writeFile(TEXT_FILE, 'linked text', 'utf-8');
  const linkPath = path.join(FIXTURES_DIR, 'linked.txt');

  try {
    await fs.symlink(TEXT_FILE, linkPath, 'file');
  } catch (error: unknown) {
    const fileError = error as NodeJS.ErrnoException;
    if (process.platform === 'win32' && fileError.code === 'EPERM') {
      console.log('  - Skipped strict UTF-8 symlink assertion: symlink permission unavailable');
      return;
    }
    throw error;
  }

  assertEqual(
    readStrictUtf8RegularFile(linkPath),
    'linked text',
    'A symlink should be accepted when its opened target is a regular file',
  );
}

async function testRejectsPosixFifoWithoutBlocking(): Promise<void> {
  if (process.platform === 'win32') return;

  await resetFixtures();
  const fifoPath = path.join(FIXTURES_DIR, 'policy.pipe');
  const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf-8' });
  const mkfifoError = mkfifo.error as NodeJS.ErrnoException | undefined;
  if (mkfifoError?.code === 'ENOENT') {
    console.log('  - Skipped FIFO assertion: mkfifo is unavailable');
    return;
  }
  assertEqual(mkfifo.status, 0, `mkfifo should succeed: ${mkfifo.stderr}`);

  const moduleUrl = pathToFileURL(
    path.join(__dirname, '..', '..', 'src', 'config', 'strict-utf8-file.ts'),
  ).href;
  const script = `
    import { readStrictUtf8RegularFile } from ${JSON.stringify(moduleUrl)};
    try {
      readStrictUtf8RegularFile(${JSON.stringify(fifoPath)});
      process.exitCode = 2;
    } catch (error) {
      console.log(error?.reason ?? 'unknown');
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { encoding: 'utf-8', timeout: 2_000 },
  );

  assert(result.error === undefined, `FIFO read should not time out: ${String(result.error)}`);
  assertEqual(result.status, 0, `FIFO child should exit successfully: ${result.stderr}`);
  assertEqual(
    result.stdout.trim(),
    'not_regular',
    'A FIFO should be rejected by fstat without waiting for a writer',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing strict UTF-8 regular-file boundary',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'reads regular UTF-8 files', run: testReadsRegularUtf8File },
      { name: 'consumes exactly one UTF-8 BOM', run: testConsumesExactlyOneBom },
      { name: 'classifies file boundary failures', run: testClassifiesBoundaryFailures },
      { name: 'follows symlinks to regular files', run: testFollowsSymlinkToRegularFile },
      { name: 'rejects POSIX FIFOs without blocking', run: testRejectsPosixFifoWithoutBlocking },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

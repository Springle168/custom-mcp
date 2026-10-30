import * as fs from 'node:fs/promises';
import mutableFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { mock } from 'node:test';
import { classifyFileContent } from '../../src/engine/file-content.js';
import { readSourceFile } from '../../src/utils/file-read.js';
import { MAX_FILE_SIZE_MB } from '../../src/utils/file-read-policy.js';
import { supportedImages } from '../file-content/fixtures.js';
import { assert, assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';
import { cleanupFixtures, FIXTURES_DIR, prepareFixtures } from './fixtures.js';

const SOURCE = path.join(FIXTURES_DIR, 'source.bin');
const MAX_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

async function withReadBytes(
  bytes: Buffer,
  run: (readCalls: () => number) => Promise<void>,
): Promise<void> {
  const original = mutableFs.readFile;
  let calls = 0;
  const replacement = mock.method(mutableFs, 'readFile', async (...args: unknown[]) => {
    if (String(args[0]) === SOURCE) {
      calls++;
      return bytes;
    }
    return Reflect.apply(original, mutableFs, args);
  });
  syncBuiltinESMExports();
  try {
    await run(() => calls);
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
}

async function testTextDecoding(): Promise<void> {
  for (const text of ['', '\uFEFF中文 😀\r\nsecond\r\n']) {
    await fs.writeFile(SOURCE, text);
    const result = await readSourceFile(SOURCE, new AbortController().signal);
    assert(result.ok && result.kind === 'text', 'Admitted UTF-8 returns a text source');
    assertEqual(
      JSON.stringify(result.lines),
      JSON.stringify(text.split(/\r?\n/)),
      'Text keeps BOM, empty content, and trailing empty lines',
    );
  }
}

async function testImageBytesAndClassification(): Promise<void> {
  for (const image of supportedImages) {
    await fs.writeFile(SOURCE, image.bytes);
    const signal = new AbortController().signal;
    let calls = 0;
    let classifiedBytes: Uint8Array | undefined;
    const result = await readSourceFile(SOURCE, signal, async (bytes, detectedSignal) => {
      calls++;
      classifiedBytes = bytes;
      assertEqual(detectedSignal, signal, 'The classifier receives the source signal');
      return classifyFileContent(bytes, detectedSignal);
    });
    assert(result.ok && result.kind === 'image', 'Supported bytes return an image source');
    assertEqual(calls, 1, 'The source is classified once');
    assertEqual(result.format, image.format, 'Format comes from content, not the .bin suffix');
    assertEqual(result.bytes, classifiedBytes, 'Returned bytes are the same classified buffer');
    assert(result.bytes.equals(image.bytes), 'Source bytes are not decoded or transformed');
  }
}

async function testStatSizeAdmission(): Promise<void> {
  try {
    for (const size of [MAX_BYTES, MAX_BYTES + 1]) {
      await fs.truncate(SOURCE, size);
      await withReadBytes(Buffer.from('admitted read'), async (readCalls) => {
        let classifications = 0;
        const result = await readSourceFile(SOURCE, new AbortController().signal, async () => {
          classifications++;
          return { kind: 'text' };
        });
        if (size === MAX_BYTES) {
          assert(result.ok && result.kind === 'text', 'A stat size of exactly 20 MiB is admitted');
          assertEqual(readCalls(), 1, 'An admitted source proceeds to full reading');
          assertEqual(classifications, 1, 'An admitted source proceeds to classification');
        } else {
          assert(!result.ok, 'A stat size above the limit fails');
          assertEqual(
            result.reason,
            `exceeds ${MAX_FILE_SIZE_MB} MiB size limit`,
            'Size failure is controlled',
          );
          assertEqual(readCalls(), 0, 'Stat rejects an oversized source before full reading');
          assertEqual(classifications, 0, 'An oversized source is never classified');
        }
      });
    }
  } finally {
    await fs.writeFile(SOURCE, 'small');
  }
}

async function testActualByteSizeAdmission(): Promise<void> {
  // A small stat with a larger read deterministically models growth between both operations.
  await fs.writeFile(SOURCE, 'small');
  for (const kind of ['text', 'image'] as const) {
    for (const size of [MAX_BYTES, MAX_BYTES + 1]) {
      const bytes = Buffer.alloc(size, 0x61);
      await withReadBytes(bytes, async (readCalls) => {
        let classifications = 0;
        const result = await readSourceFile(SOURCE, new AbortController().signal, async (input) => {
          classifications++;
          assertEqual(input, bytes, 'Classification uses the single complete read');
          return kind === 'text' ? { kind: 'text' } : { kind: 'image', format: 'png' };
        });
        assertEqual(readCalls(), 1, 'The source is read once');
        if (size === MAX_BYTES) {
          assert(result.ok, 'Exactly 20 MiB is allowed after reading');
          assertEqual(result.kind, kind, 'Both text and image share the inclusive boundary');
          assertEqual(classifications, 1, 'Admitted bytes are classified once');
        } else {
          assert(!result.ok, 'Growth beyond the limit is rejected after reading');
          assertEqual(
            result.reason,
            `exceeds ${MAX_FILE_SIZE_MB} MiB size limit`,
            'Growth has the same controlled size failure',
          );
          assertEqual(classifications, 0, 'Oversized actual bytes never reach classification');
        }
      });
    }
  }
}

async function testClassificationFailures(): Promise<void> {
  await fs.writeFile(SOURCE, 'small');
  for (const kind of ['other', 'unknown'] as const) {
    const result = await readSourceFile(SOURCE, new AbortController().signal, async () => ({
      kind,
    }));
    assert(!result.ok, 'Non-text, non-supported-image classifications fail locally');
    assertEqual(
      result.reason,
      kind === 'other'
        ? 'non-text file (recognized binary format)'
        : 'non-text file (unknown binary content)',
      'Binary classifications keep distinct safe reasons',
    );
  }

  const result = await readSourceFile(SOURCE, new AbortController().signal, async () => {
    throw new Error('private-classifier-path');
  });
  assert(!result.ok, 'Classification exceptions become a local source failure');
  assertEqual(
    result.reason,
    'file content could not be classified',
    'Detector errors use fixed text',
  );
  assertNotIncludes(result.reason, 'private-classifier-path', 'Detector details stay private');
}

async function testCancellationBoundaries(): Promise<void> {
  const reason = new Error('controlled-cancellation');
  const preCancelled = new AbortController();
  preCancelled.abort(reason);
  await withReadBytes(Buffer.from('never read'), async (readCalls) => {
    let caught: unknown;
    try {
      await readSourceFile(SOURCE, preCancelled.signal);
    } catch (error) {
      caught = error;
    }
    assertEqual(caught, reason, 'Pre-cancellation propagates instead of becoming a local failure');
    assertEqual(readCalls(), 0, 'Pre-cancellation performs no full read');
  });

  const controller = new AbortController();
  let caught: unknown;
  try {
    await readSourceFile(SOURCE, controller.signal, async (_bytes, signal) => {
      assertEqual(signal, controller.signal, 'The classifier receives cancellation');
      controller.abort(reason);
      return { kind: 'image', format: 'png' };
    });
  } catch (error) {
    caught = error;
  }
  assertEqual(caught, reason, 'Cancellation after classification never returns a source success');
}

await runTestSuite({
  title: 'Testing complete source reads for text and images',
  beforeAll: async () => {
    await prepareFixtures();
    await fs.writeFile(SOURCE, 'small');
  },
  afterAll: cleanupFixtures,
  tests: [
    { name: 'text decoding preserves source line semantics', run: testTextDecoding },
    {
      name: 'images preserve the once-classified original buffer',
      run: testImageBytesAndClassification,
    },
    { name: 'stat rejects oversized sources before full reading', run: testStatSizeAdmission },
    {
      name: 'actual bytes are rechecked with an inclusive 20 MiB limit',
      run: testActualByteSizeAdmission,
    },
    {
      name: 'binary and classification failures remain safe and distinct',
      run: testClassificationFailures,
    },
    {
      name: 'cancellation propagates before reads and after classification',
      run: testCancellationBoundaries,
    },
  ],
});

import { fileTypeFromBuffer } from 'file-type';
import {
  classifyFileContent,
  type FileContentClassification,
} from '../../src/engine/file-content.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';
import { animatedPng, recognizedBinary, supportedImages, unsupportedImage } from './fixtures.js';

async function assertKind(
  bytes: Uint8Array,
  expected: FileContentClassification['kind'],
  message: string,
): Promise<void> {
  assertEqual((await classifyFileContent(bytes)).kind, expected, message);
}

async function testTextRepresentations(): Promise<void> {
  for (const text of [
    '',
    'a',
    'export const answer: number = 42;\n',
    '中文与 emoji 😀🚀\n',
    'extensionless text',
    '\uFEFFfirst\r\nsecond\nthird\rfourth',
    '{"name":"example","enabled":true}\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><text>中文</text></svg>',
    '{\\rtf1\\ansi Plain text}',
    '%!PS-Adobe-3.0\n/showpage {} def\n',
  ]) {
    await assertKind(Buffer.from(text), 'text', `UTF-8 text should pass: ${JSON.stringify(text)}`);
  }
}

async function testSupportedImages(): Promise<void> {
  for (const { format, bytes } of supportedImages) {
    const expectedMime = `image/${format}`;
    assertEqual(
      (await fileTypeFromBuffer(bytes))?.mime,
      expectedMime,
      `${format} fixture must exercise real format detection`,
    );

    const result = await classifyFileContent(bytes);
    assert(result.kind === 'image', `${format} should be an image without a filename`);
    assertEqual(result.format, format, 'Detected image formats should be normalized');
  }
}

async function testImageWhitelist(): Promise<void> {
  for (const [bytes, mime] of [
    [unsupportedImage, 'image/gif'],
    [animatedPng, 'image/apng'],
  ] as const) {
    assertEqual(
      (await fileTypeFromBuffer(bytes))?.mime,
      mime,
      'Unsupported image fixture should have a distinct detected MIME',
    );
    await assertKind(bytes, 'other', `${mime} must not gain image support implicitly`);
  }
}

async function testXmlFallback(): Promise<void> {
  const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><root>中文 😀</root>');
  assertEqual(
    (await fileTypeFromBuffer(xml))?.mime,
    'application/xml',
    'XML fixture should exercise recognized-format fallback',
  );
  await assertKind(xml, 'text', 'Recognized XML should still pass full text checks');
}

async function testNonTargetImageTextFallback(): Promise<void> {
  const bytes = Buffer.from('GIF89a printable signature collision, not a decodable image');
  assertEqual(
    (await fileTypeFromBuffer(bytes))?.mime,
    'image/gif',
    'Printable fixture should collide with an unsupported image signature',
  );
  await assertKind(bytes, 'text', 'Non-target image signatures must still use text fallback');
}

async function testTransportStreamTextFallback(): Promise<void> {
  for (const [firstSync, secondSync] of [
    [0, 188],
    [4, 196],
  ] as const) {
    const bytes = Buffer.alloc(400, 0x61);
    bytes[firstSync] = 0x47;
    bytes[secondSync] = 0x47;
    assertEqual(
      (await fileTypeFromBuffer(bytes))?.mime,
      'video/mp2t',
      'Legal ASCII fixture should trigger the weak MPEG transport stream signature',
    );
    await assertKind(bytes, 'text', 'Weak media signatures must not take precedence over text');
  }
}

async function testBinaryCategories(): Promise<void> {
  assertEqual(
    (await fileTypeFromBuffer(recognizedBinary))?.mime,
    'application/pdf',
    'Recognized binary fixture should exercise the other branch',
  );
  await assertKind(recognizedBinary, 'other', 'Known non-text should be other');

  const unknown = Uint8Array.of(0xff, 0x00, 0xfe, 0x01);
  assertEqual(
    await fileTypeFromBuffer(unknown),
    undefined,
    'Unknown fixture must not acquire a recognized format',
  );
  await assertKind(unknown, 'unknown', 'Unrecognized non-text should be unknown');
}

async function testStrictUtf8(): Promise<void> {
  for (const bytes of [
    Uint8Array.of(0xc3, 0x28),
    Uint8Array.of(0xc0, 0xaf),
    Uint8Array.of(0xed, 0xa0, 0x80),
    Uint8Array.of(0xe2, 0x82),
    Uint8Array.of(0xf4, 0x90, 0x80, 0x80),
    Uint8Array.of(0xff, 0xfe, 0x61, 0x00),
    Uint8Array.of(0xe9),
  ]) {
    await assertKind(
      bytes,
      'unknown',
      'Malformed or non-UTF-8 bytes must not be decoded leniently',
    );
  }

  await assertKind(
    Buffer.from('A real replacement character: \uFFFD'),
    'text',
    'An explicitly encoded replacement character is valid UTF-8',
  );
}

async function testNul(): Promise<void> {
  await assertKind(
    Buffer.from(`${'ordinary text '.repeat(100)}\x00`),
    'unknown',
    'Even one NUL must fail regardless of its control-byte ratio',
  );
}

async function testWholeFileValidation(): Promise<void> {
  const prefix = Buffer.alloc(8192, 0x61);
  for (const tail of [Buffer.from([0xc3, 0x28]), Buffer.from([0x00])]) {
    await assertKind(
      Buffer.concat([prefix, tail]),
      'unknown',
      'Invalid UTF-8 or NUL after 4 KiB must not be hidden by a text prefix',
    );
  }

  await assertKind(
    Buffer.concat([prefix, Buffer.from('中文😀')]),
    'text',
    'Valid multibyte text beyond the old sampling boundary should pass',
  );
  await assertKind(
    Buffer.concat([prefix, Buffer.alloc(8192, 0x01)]),
    'unknown',
    'The control-byte ratio must also include content beyond the text prefix',
  );
}

async function testControlThreshold(): Promise<void> {
  await assertKind(Buffer.from('\x01\x02\x03abcdefg'), 'text', 'Exactly 30% should pass');
  await assertKind(Buffer.from('\x01\x02abcdefghi'), 'text', 'Below 30% should pass');
  await assertKind(
    Buffer.concat([Buffer.alloc(3001, 0x01), Buffer.alloc(6999, 0x61)]),
    'unknown',
    'A control-byte ratio of 30.01% should fail',
  );
  await assertKind(
    Buffer.from('\x01\x02\x03中文a'),
    'text',
    'The denominator must count UTF-8 bytes, not code points',
  );
}

async function testControlDefinition(): Promise<void> {
  await assertKind(
    Uint8Array.of(9, 10, 11, 12, 13, 0x7f),
    'text',
    'Whitespace bytes 9–13 and DEL are outside the inherited control definition',
  );

  for (const byte of [1, 8, 14, 31]) {
    await assertKind(
      Uint8Array.of(byte),
      'unknown',
      `Control byte ${byte} must count toward the threshold`,
    );
  }
}

async function testByteViewAndOwnership(): Promise<void> {
  for (const { bytes, format } of supportedImages) {
    const wrapped = Buffer.concat([Buffer.from([0xff]), bytes, Buffer.from([0xff])]);
    const before = Buffer.from(wrapped);
    const view = new Uint8Array(wrapped.buffer, wrapped.byteOffset + 1, bytes.length);
    const result = await classifyFileContent(view);
    assert(result.kind === 'image', 'Only the supplied Uint8Array view should be classified');
    assertEqual(result.format, format, 'Byte offsets must not alter detected image format');
    assertEqual(Buffer.compare(wrapped, before), 0, 'Classification must not mutate caller bytes');
  }
}

async function testCancellationPropagation(): Promise<void> {
  const reason = Object.assign(new Error('detection aborted'), { code: 'ENOENT' });
  const controller = new AbortController();
  controller.abort(reason);
  let detectorError: unknown;
  try {
    await fileTypeFromBuffer(Buffer.from('ordinary text'), { signal: controller.signal });
  } catch (error) {
    detectorError = error;
  }

  let caught: unknown;
  try {
    await classifyFileContent(Buffer.from('ordinary text'), controller.signal);
  } catch (error) {
    caught = error;
  }

  assert(detectorError instanceof Error, 'The dependency must reject an aborted detection');
  assert(caught instanceof Error, 'Classification must reject instead of returning a content kind');
  assertEqual(
    caught.name,
    detectorError.name,
    'Classification should preserve detector error names',
  );
  assertEqual(
    caught.message,
    detectorError.message,
    'Classification should preserve detector error messages rather than rewrite signal reasons',
  );
}

async function testIndependentCalls(): Promise<void> {
  const cancelled = new AbortController();
  const reason = new Error('one call only');
  cancelled.abort(reason);
  const bytes = supportedImages[0]!.bytes;
  const results = await Promise.allSettled([
    classifyFileContent(bytes, cancelled.signal),
    classifyFileContent(Buffer.from('independent text')),
    ...supportedImages.map(({ bytes: image }) => classifyFileContent(image)),
    classifyFileContent(recognizedBinary),
  ]);

  const first = results[0]!;
  assert(first.status === 'rejected', 'Cancelled classification should reject');
  assert(first.reason instanceof Error, 'A cancelled detector should propagate an error');
  assertEqual(first.reason.name, 'AbortError', 'The detector cancellation must not become a kind');
  const expectedKinds = ['text', 'image', 'image', 'image', 'other'];
  for (const [index, expected] of expectedKinds.entries()) {
    const result = results[index + 1]!;
    assert(result.status === 'fulfilled', 'One cancelled call must not affect other parsers');
    assertEqual(
      result.value.kind,
      expected,
      'Concurrent calls should keep their own classification',
    );
  }
}

runTestSuite({
  title: 'File content classification',
  tests: [
    { name: 'accepts supported UTF-8 text representations', run: testTextRepresentations },
    { name: 'recognizes real PNG, JPEG and WebP images', run: testSupportedImages },
    { name: 'does not implicitly support GIF or APNG', run: testImageWhitelist },
    { name: 'checks recognized XML as text', run: testXmlFallback },
    { name: 'checks non-target image signatures as text', run: testNonTargetImageTextFallback },
    { name: 'checks weak MPEG transport signatures as text', run: testTransportStreamTextFallback },
    { name: 'distinguishes recognized and unknown non-text', run: testBinaryCategories },
    { name: 'requires strict full UTF-8', run: testStrictUtf8 },
    { name: 'rejects every NUL', run: testNul },
    { name: 'validates beyond 4 KiB', run: testWholeFileValidation },
    { name: 'enforces the exact byte-based 30% threshold', run: testControlThreshold },
    { name: 'preserves the existing control-byte definition', run: testControlDefinition },
    { name: 'respects byte views without modifying input', run: testByteViewAndOwnership },
    { name: 'propagates detector cancellation errors', run: testCancellationPropagation },
    { name: 'keeps concurrent detections independent', run: testIndependentCalls },
  ],
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

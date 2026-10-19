import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import readTool from '../../src/tools/built-in/files/read.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import { assert } from '../test-utils.js';

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/read/', import.meta.url));

export async function prepareFixtures(): Promise<void> {
  await cleanupFixtures();
  const files: Record<string, string | Uint8Array> = {
    'a.txt': 'alpha\nbeta\ngamma\n',
    'b.txt': 'B-body',
    'c.txt': 'C-body',
    'empty.txt': '',
    'crlf.txt': '中文\r\n😀\r\n',
    'markers.txt': 'end\nstart\nmiddle\nend\nstart\nend',
    'special/file[test].txt': 'brackets-body',
    'special/file{a,b}.txt': 'braces-body',
    'nested/z.txt': 'nested-body',
    'node_modules/dependency.txt': 'dependency-body',
    'fake.png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    'binary.unknown': Uint8Array.from([0, 0, 0, 1, 2, 3]),
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(FIXTURES_DIR, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

export async function cleanupFixtures(): Promise<void> {
  const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
  assert(
    path.dirname(path.resolve(FIXTURES_DIR)) === path.resolve(fixtureRoot),
    'Cleanup must stay inside fixtures',
  );
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

export function context() {
  return createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
}

export function read(args: Record<string, unknown>): Promise<ToolCallResult> {
  return readTool.handler(args, context(), createTestToolInvocationContext());
}

export function block(result: ToolCallResult, index: number): string {
  const item = result.content[index];
  assert(item?.type === 'text', `Result block ${index} must be text`);
  return item.text;
}

export function body(result: ToolCallResult, index = 1): string {
  const text = block(result, index);
  const separator = text.indexOf('\n\n');
  assert(separator !== -1, 'Request block must separate its header from its body');
  return text.slice(separator + 2);
}

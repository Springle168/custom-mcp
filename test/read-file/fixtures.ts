import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'read-file');

const FOO_CONTENT = `package com.example.demo

/**
 * A simple data class representing a user.
 */
data class Foo(
    val id: Long,
    val name: String,
    val email: String
) {
    fun isValid(): Boolean {
        return name.isNotBlank() && email.contains("@")
    }
}
`;

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

export async function prepareFixtures(): Promise<void> {
  await cleanupFixtures();
  await Promise.all([
    fs.mkdir(path.join(FIXTURES_DIR, 'src'), { recursive: true }),
    fs.mkdir(path.join(FIXTURES_DIR, 'binary'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(FIXTURES_DIR, 'src', 'Foo.kt'), FOO_CONTENT, 'utf-8'),
    fs.writeFile(path.join(FIXTURES_DIR, 'binary', 'fake.png'), PNG_BYTES),
  ]);
}

export async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

export async function withTempTextFile(
  fileName: string,
  content: string,
  run: (fileName: string) => Promise<void>,
): Promise<void> {
  const filePath = path.join(FIXTURES_DIR, fileName);
  await fs.writeFile(filePath, content, 'utf-8');

  try {
    await run(fileName);
  } finally {
    await fs.rm(filePath, { force: true });
  }
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'read-many-files');

const FIXTURE_FILES: Readonly<Record<string, string | Uint8Array>> = {
  'src/Foo.kt': `package com.example.demo

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
`,
  'src/Bar.kt': `package com.example.demo

/**
 * Service class for business logic.
 */
class Bar(private val repository: FooRepository) {

    fun findById(id: Long): Foo? {
        return repository.findById(id)
    }

    fun save(foo: Foo): Foo {
        require(foo.isValid()) { "Invalid foo object" }
        return repository.save(foo)
    }
}
`,
  'src/nested/Deep.kt': `package com.example.demo.nested

/**
 * A deeply nested utility class.
 */
object Deep {

    fun formatMessage(text: String): String {
        return "[DEEP] $text"
    }

    fun calculate(a: Int, b: Int): Int {
        return a * b + 42
    }
}
`,
  'docs/README.md': `# Demo Project

This is a sample Kotlin project for testing purposes.

## Features

- Data classes
- Service layer
- Nested packages

## Usage

\`\`\`kotlin
val foo = Foo(1L, "Alice", "alice@example.com")
val bar = Bar(repository)
bar.save(foo)
\`\`\`

## Notes

This file is used for testing the read_many_files tool.
`,
  'node_modules/excluded.txt': `This file should be excluded by default.
It's inside node_modules directory.
`,
  'build/excluded.txt': `This file should also be excluded by default.
It's inside build output directory.
`,
  'special-names/file[test].kt': `package com.example.special

/**
 * File with brackets in name.
 */
class FileWithBrackets {
    fun test() = "brackets"
}
`,
  'special-names/file{brace}.kt': `package com.example.special

/**
 * File with braces in name.
 */
class FileWithBraces {
    fun test() = "braces"
}
`,
  'binary/fake.png': Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]),
};

export async function prepareFixtures(): Promise<void> {
  await cleanupFixtures();

  for (const [relativePath, content] of Object.entries(FIXTURE_FILES)) {
    const filePath = path.join(FIXTURES_DIR, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
}

export async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

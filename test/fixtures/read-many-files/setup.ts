// test/fixtures/read-many-files/setup.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fixtures root directory
const FIXTURES_ROOT = __dirname;

// File contents
const FILES = {
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

  'binary/fake.png': Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,  // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,  // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,  // 1x1 pixel
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82
  ]),
};

async function createFixtures() {
  console.log('Creating test fixtures for read_many_files...\n');

  try {
    // Create all necessary directories
    const dirs = [
      'src',
      'src/nested',
      'docs',
      'node_modules',
      'build',
      'special-names',
      'binary',
    ];

    for (const dir of dirs) {
      const dirPath = path.join(FIXTURES_ROOT, dir);
      await fs.mkdir(dirPath, { recursive: true });
      console.log(`✓ Created directory: ${dir}/`);
    }

    console.log();

    // Write all files
    for (const [filePath, content] of Object.entries(FILES)) {
      const fullPath = path.join(FIXTURES_ROOT, filePath);
      await fs.writeFile(fullPath, content, 'utf-8');
      console.log(`✓ Created file: ${filePath}`);
    }

    console.log('\n✅ All fixtures created successfully!');
    console.log(`\nFixtures location: ${FIXTURES_ROOT}`);
    console.log('\nYou can now run: npx tsx test/read-many-files/read-many-files.test.ts');
  } catch (error) {
    console.error('❌ Error creating fixtures:', error);
    process.exit(1);
  }
}

async function cleanFixtures() {
  console.log('Cleaning test fixtures...\n');

  try {
    // Remove all files and directories
    const items = ['src', 'docs', 'node_modules', 'build'];

    for (const item of items) {
      const itemPath = path.join(FIXTURES_ROOT, item);
      try {
        await fs.rm(itemPath, { recursive: true, force: true });
        console.log(`✓ Removed: ${item}`);
      } catch (err) {
        // Ignore if doesn't exist
      }
    }

    console.log('\n✅ Fixtures cleaned!');
  } catch (error) {
    console.error('❌ Error cleaning fixtures:', error);
    process.exit(1);
  }
}

// Main
const command = process.argv[2];

if (command === 'clean') {
  await cleanFixtures();
} else {
  await createFixtures();
}

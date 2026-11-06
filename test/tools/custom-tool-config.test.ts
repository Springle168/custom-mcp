import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../src/config/errors.js';
import { loadCustomToolConfig } from '../../src/tools/custom-tool-config.js';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';

const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
let fixturesDir: string;
let toolConfigFile: string;
let firstDefinitionFile: string;
let secondDefinitionFile: string;

async function setupFixtures(): Promise<void> {
  await fs.mkdir(FIXTURES_ROOT, { recursive: true });
  fixturesDir = await fs.mkdtemp(path.join(FIXTURES_ROOT, 'custom-tool-config-'));
  toolConfigFile = path.join(fixturesDir, 'tool-config.json');
  firstDefinitionFile = path.join(fixturesDir, 'first.json');
  secondDefinitionFile = path.join(fixturesDir, 'second.json');
}

async function cleanupFixtures(): Promise<void> {
  if (fixturesDir !== undefined) {
    await fs.rm(fixturesDir, { recursive: true, force: true });
  }
}

async function writeJson(filePath: string, value: unknown, bomCount = 0): Promise<void> {
  await fs.writeFile(filePath, '\uFEFF'.repeat(bomCount) + JSON.stringify(value), 'utf-8');
}

function reference(id = 'first-ref', file = firstDefinitionFile): Record<string, unknown> {
  return { id, toolDefinitionFile: file };
}

function toolConfig(
  definitions: unknown[] = [reference()],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { version: 2, definitions, ...extra };
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    return error;
  }
  throw new Error('Expected loading to fail');
}

async function testLoadsOrderedFrozenDeclarations(): Promise<void> {
  const declaration = {
    name: 'Read.Tool',
    $alias: 'read_tool',
    description: '  Preserved whitespace.  ',
    $inheritTopDescription: false,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    $inheritInputSchema: false,
  };
  await writeJson(firstDefinitionFile, declaration, 1);
  await writeJson(secondDefinitionFile, { name: 'read.tool', $inheritInputSchema: true });
  await writeJson(
    toolConfigFile,
    toolConfig([reference(), reference('second-ref', secondDefinitionFile)]),
    1,
  );

  const loaded = loadCustomToolConfig(toolConfigFile);
  assertEqual(loaded.definitions.length, 2, 'All references should load in order');
  const first = loaded.definitions[0];
  assert(first !== undefined, 'First declaration should exist');
  assertEqual(
    JSON.stringify(first.declaration),
    JSON.stringify(declaration),
    'Source fields should remain unchanged',
  );
  assertEqual(
    loaded.definitions[1]?.declaration.name,
    'read.tool',
    'Names are case-sensitive and preserve reference order',
  );
  assertEqual(first.source.toolConfigFilePath, toolConfigFile, 'Source should retain config file');
  assertEqual(
    first.source.toolDefinitionFilePath,
    firstDefinitionFile,
    'Source should retain actual definition file',
  );
  assertEqual(first.source.referenceId, 'first-ref', 'Source should retain reference id');
  assertEqual(
    loaded.definitions[1]?.source.definitionIndex,
    1,
    'Source should retain reference index',
  );
  assert(!('externalRoutingConfigFilePath' in loaded), 'Absent optional fields should be omitted');
  assert(!('validator' in first), 'Loaded declarations do not own validators');
  for (const value of [
    loaded,
    loaded.definitions,
    first,
    first.source,
    first.declaration,
    first.declaration.inputSchema,
    first.declaration.inputSchema?.properties,
  ]) {
    assert(Object.isFrozen(value), 'Loaded data should be deeply frozen');
  }
}

async function testDefersSemanticAndRoutingWork(): Promise<void> {
  const routeFile = path.join(fixturesDir, 'does-not-exist.json');
  // Invalid schema and mutually exclusive instructions are syntactically valid
  // declarations; only compilation is allowed to reject their semantics.
  const declaration = {
    name: 'read',
    description: 'Explicit',
    $inheritTopDescription: true,
    inputSchema: { type: 'array', required: 'invalid', $ref: 'https://unresolved.example/schema' },
    $inheritInputSchema: true,
  };
  await writeJson(firstDefinitionFile, declaration);
  await writeJson(
    toolConfigFile,
    toolConfig([reference()], { externalRoutingConfigFile: routeFile }),
  );
  const loaded = loadCustomToolConfig(toolConfigFile);
  assertEqual(
    loaded.externalRoutingConfigFilePath,
    routeFile,
    'Loader returns the routing path without reading it',
  );
  assertEqual(
    JSON.stringify(loaded.definitions[0]?.declaration),
    JSON.stringify(declaration),
    'Loader does not interpret inheritance or compile schemas',
  );

  await writeJson(firstDefinitionFile, { name: 'missing-schema' });
  assertEqual(
    loadCustomToolConfig(toolConfigFile).definitions[0]?.declaration.name,
    'missing-schema',
    'Schema presence belongs to compilation',
  );
}

async function testStrictConfigShell(): Promise<void> {
  await writeJson(toolConfigFile, toolConfig([]));
  assertEqual(
    loadCustomToolConfig(toolConfigFile).definitions.length,
    0,
    'Empty definitions are valid',
  );
  const cases: readonly [unknown, string | undefined][] = [
    [null, undefined],
    [{ version: 1, definitions: [] }, 'version'],
    [{ version: 2 }, 'definitions'],
    [toolConfig([], { unknown: true }), 'unknown'],
    [toolConfig([], { processorConfigFile: firstDefinitionFile }), 'processorConfigFile'],
    [toolConfig([], { externalRoutingConfigFile: 'relative.json' }), 'externalRoutingConfigFile'],
    [
      toolConfig([reference('duplicate'), reference('duplicate', secondDefinitionFile)]),
      'definitions[1].id',
    ],
    [toolConfig([reference('bad id')]), 'definitions[0].id'],
    [toolConfig([{ toolDefinitionFile: firstDefinitionFile }]), 'definitions[0].id'],
    [toolConfig([{ id: 'id' }]), 'definitions[0].toolDefinitionFile'],
    [toolConfig([reference('id', 'relative.json')]), 'definitions[0].toolDefinitionFile'],
    [toolConfig([{ ...reference(), unknown: true }]), 'definitions[0].unknown'],
    [toolConfig([null]), 'definitions[0]'],
  ];
  for (const [value, fieldPath] of cases) {
    await writeJson(toolConfigFile, value);
    const error = captureConfigError(() => loadCustomToolConfig(toolConfigFile));
    assertEqual(error.configFilePath, toolConfigFile, 'Config shell errors belong to the config');
    assertEqual(error.fieldPath, fieldPath, 'Config shell errors identify the field');
  }
}

async function testStrictDeclarationFields(): Promise<void> {
  await writeJson(toolConfigFile, toolConfig());
  const cases: [unknown, string | undefined][] = [
    [null, undefined],
    [[], undefined],
    [{}, 'name'],
    [{ name: 'valid', title: 'unknown' }, 'title'],
    [{ name: 'valid', $unknown: true }, '$unknown'],
  ];
  for (const name of [
    '',
    ' spaced',
    'spaced ',
    'contains space',
    '工具',
    'a'.repeat(129),
    null,
    true,
    3,
  ]) {
    cases.push([{ name }, 'name']);
  }
  for (const alias of ['', ' alias', 'alias ', 'a'.repeat(129), null, false, 3]) {
    cases.push([{ name: 'valid', $alias: alias }, '$alias']);
  }
  for (const description of ['', ' \t\n ', null, false, 3]) {
    cases.push([{ name: 'valid', description }, 'description']);
  }
  for (const key of ['$inheritTopDescription', '$inheritInputSchema']) {
    for (const value of [null, 'true', 1, {}, []]) {
      cases.push([{ name: 'valid', [key]: value }, key]);
    }
  }
  for (const inputSchema of [null, true, false, [], 'object']) {
    cases.push([{ name: 'valid', inputSchema }, 'inputSchema']);
  }
  for (const [value, fieldPath] of cases) {
    await writeJson(firstDefinitionFile, value);
    const error = captureConfigError(() => loadCustomToolConfig(toolConfigFile));
    assertEqual(
      error.code,
      'config_validation_failed',
      'Invalid declarations use structured validation errors',
    );
    assertEqual(
      error.configFilePath,
      firstDefinitionFile,
      'Declaration errors belong to the actual file',
    );
    assertEqual(error.fieldPath, fieldPath, 'Declaration error identifies its field');
    assertIncludes(error.message, 'first-ref', 'Declaration errors retain reference identity');
  }

  for (const name of ['A._-09', 'a'.repeat(128)]) {
    await writeJson(firstDefinitionFile, {
      name,
      $alias: name,
      $inheritTopDescription: false,
      $inheritInputSchema: false,
    });
    assertEqual(
      loadCustomToolConfig(toolConfigFile).definitions[0]?.declaration.name,
      name,
      'Grammar boundary and explicit false are accepted',
    );
  }
}

async function testDuplicateStableNames(): Promise<void> {
  await writeJson(firstDefinitionFile, { name: 'same-name', $alias: 'first' });
  await writeJson(secondDefinitionFile, { name: 'same-name', $alias: 'second' });
  await writeJson(
    toolConfigFile,
    toolConfig([reference(), reference('second-ref', secondDefinitionFile)]),
  );
  const error = captureConfigError(() => loadCustomToolConfig(toolConfigFile));
  assertEqual(error.configFilePath, toolConfigFile, 'Duplicate stable names belong to Tool config');
  assertEqual(
    error.fieldPath,
    'definitions[1].toolDefinitionFile',
    'Duplicate names identify later reference',
  );
  for (const detail of ['same-name', 'first-ref', 'second-ref']) {
    assertIncludes(error.message, detail, 'Duplicate diagnostic includes name and both references');
  }
}

async function testReferencedFileErrors(): Promise<void> {
  const missingFile = path.join(fixturesDir, 'missing.json');
  await writeJson(toolConfigFile, toolConfig([reference('missing-ref', missingFile)]));
  let error = captureConfigError(() => loadCustomToolConfig(toolConfigFile));
  assertEqual(error.code, 'config_file_not_found', 'Missing files retain their file error code');
  assertEqual(error.configFilePath, missingFile, 'Missing file error identifies referenced file');
  assertIncludes(error.message, 'missing-ref', 'Missing file error retains reference identity');

  await writeJson(toolConfigFile, toolConfig());
  const cases: readonly [string | Buffer, string, string][] = [
    [Buffer.from([0xc3, 0x28]), 'config_file_read_failed', 'valid UTF-8'],
    ['{ invalid json', 'config_json_invalid', 'invalid JSON'],
    ['\uFEFF\uFEFF{}', 'config_json_invalid', 'invalid JSON'],
  ];
  for (const [content, code, message] of cases) {
    await fs.writeFile(firstDefinitionFile, content);
    error = captureConfigError(() => loadCustomToolConfig(toolConfigFile));
    assertEqual(error.code, code, 'File errors retain their original code');
    assertEqual(error.configFilePath, firstDefinitionFile, 'File error identifies referenced file');
    assertIncludes(error.message, message, 'File error explains its cause');
    assertIncludes(error.message, 'first-ref', 'File error retains reference identity');
  }

  const directory = path.join(fixturesDir, 'not-a-file');
  await fs.mkdir(directory, { recursive: true });
  await writeJson(toolConfigFile, toolConfig([reference('directory-ref', directory)]));
  error = captureConfigError(() => loadCustomToolConfig(toolConfigFile));
  assertEqual(error.configFilePath, directory, 'Directories fail at the referenced file boundary');
  assertIncludes(error.message, 'regular file', 'Directory error explains file requirement');
  assertIncludes(error.message, 'directory-ref', 'Directory error retains reference identity');

  await writeJson(toolConfigFile, toolConfig([]), 2);
  error = captureConfigError(() => loadCustomToolConfig(toolConfigFile));
  assertEqual(error.code, 'config_json_invalid', 'A second BOM is not stripped');
  assertEqual(error.configFilePath, toolConfigFile, 'Config JSON errors belong to the config');
}

await runTestSuite({
  title: 'Testing custom Tool source loading',
  beforeAll: setupFixtures,
  afterAll: cleanupFixtures,
  tests: [
    {
      name: 'loads ordered deeply frozen source declarations',
      run: testLoadsOrderedFrozenDeclarations,
    },
    {
      name: 'defers schema, inheritance, and external routing work',
      run: testDefersSemanticAndRoutingWork,
    },
    { name: 'validates the strict Tool config shell', run: testStrictConfigShell },
    {
      name: 'validates strict declaration fields and name grammar',
      run: testStrictDeclarationFields,
    },
    {
      name: 'rejects duplicate stable names despite different aliases',
      run: testDuplicateStableNames,
    },
    { name: 'retains actual file and reference diagnostics', run: testReferencedFileErrors },
  ],
});

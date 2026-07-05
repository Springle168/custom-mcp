import { getAllToolDefinitions } from '../../src/tools/index.js';
import {
  assert,
  runTestSuite,
} from '../test-utils.js';

function testToolDefinitionsDoNotExposeOutputSchema(): void {
  const definitions = getAllToolDefinitions();

  for (const definition of definitions) {
    assert(!('outputSchema' in definition), `${definition.name} should not expose MCP outputSchema`);
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing tool definitions response shape',
    tests: [
      { name: 'tool definitions do not expose outputSchema', run: testToolDefinitionsDoNotExposeOutputSchema },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

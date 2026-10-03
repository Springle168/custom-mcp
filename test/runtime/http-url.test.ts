import { buildHttpUrl, formatHostPort } from '../../src/utils/http-url.js';
import { assertEqual, runTestSuite } from '../test-utils.js';

function testMcpEndpointUrls(): void {
  assertEqual(
    buildHttpUrl('127.0.0.1', 3100, '/mcp'),
    'http://127.0.0.1:3100/mcp',
    'IPv4 loopback should produce a directly usable MCP URL',
  );
  assertEqual(
    buildHttpUrl('::1', 3100, '/mcp'),
    'http://[::1]:3100/mcp',
    'IPv6 loopback should be bracketed in MCP URLs',
  );
  assertEqual(
    buildHttpUrl('0.0.0.0', 3100, '/mcp'),
    'http://127.0.0.1:3100/mcp',
    'IPv4 wildcard binds should log a local endpoint URL',
  );
  assertEqual(
    buildHttpUrl('::', 3100, '/mcp'),
    'http://[::1]:3100/mcp',
    'IPv6 wildcard binds should log a local endpoint URL',
  );
}

function testBindAddressFormatting(): void {
  assertEqual(formatHostPort('::', 3100), '[::]:3100', 'IPv6 bind addresses should be bracketed');
  assertEqual(
    formatHostPort('0.0.0.0', 3100),
    '0.0.0.0:3100',
    'IPv4 bind addresses should be preserved',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing MCP HTTP URL formatting',
    tests: [
      { name: 'formats MCP endpoint URLs', run: testMcpEndpointUrls },
      { name: 'formats HTTP bind addresses', run: testBindAddressFormatting },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

import type {
  CompiledExternalRoute,
  CompiledExternalRoutingConfig,
  CompiledHttpRoute,
  ExternalRequestRoutingStage,
  ExternalResponseRoutingStage,
} from '../../src/tools/external-routing/config.js';
import {
  formatApplicationStartupLines,
  formatExternalRoutingStartupLines,
  formatFileAccessPolicyStartupLines,
} from '../../src/runtime/application/startup-logging.js';
import { createTestRuntimeConfigSnapshot } from '../helpers/runtime-config.js';
import { assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';

function externalRoute(options: {
  readonly definitionId: string;
  readonly toolName: string;
  readonly endpointUrl: string;
  readonly requestStage: ExternalRequestRoutingStage;
  readonly responseStage: ExternalResponseRoutingStage;
}): CompiledHttpRoute {
  return {
    routingMode: 'http',
    definitionId: options.definitionId,
    toolName: options.toolName,
    endpointConfigFilePath: `C:\\RouteConfig\\${options.definitionId}-endpoint.json`,
    endpoint: {
      url: options.endpointUrl,
      timeoutMs: 30_000,
      headers: { Authorization: 'header-value-not-for-startup' },
    },
    requestStage: options.requestStage,
    responseStage: options.responseStage,
  };
}

function mcpRoute(options: {
  readonly definitionId: string;
  readonly toolName: string;
  readonly serverUrl: string;
}): CompiledExternalRoute {
  return {
    routingMode: 'mcp',
    definitionId: options.definitionId,
    toolName: options.toolName,
    serverConfigFilePath: `C:\\RouteConfig\\${options.definitionId}-server.json`,
    server: {
      identity: 'C:\\RealConfig\\shared-server.json',
      url: options.serverUrl,
      timeoutMs: 30_000,
      headers: { Authorization: 'mcp-header-secret', 'X-Test-Secret': 'mcp-value-secret' },
    },
  };
}

function externalRoutingConfig(
  routes: readonly CompiledExternalRoute[],
): CompiledExternalRoutingConfig {
  return {
    configFilePath: 'C:\\RouteConfig\\external-routing.json',
    processorConfigFilePath: 'C:\\RouteConfig\\processor.json',
    processorsByName: new Map([
      [
        'body-codec',
        {
          name: 'body-codec',
          executable: {
            resolution: 'absolute-path',
            path: 'C:\\RouteProcessors\\body-codec.exe',
          },
          arguments: ['--processor-argument-not-for-startup'],
          workingDirectory: 'C:\\RouteProcessors',
          timeoutMs: 30_000,
        },
      ],
    ]),
    routes,
    routesByDefinitionId: new Map(routes.map((route) => [route.definitionId, route])),
  };
}

function testFormatsStableSafeMultiRouteExternalRoutingSummary(): void {
  const summary = formatExternalRoutingStartupLines(
    externalRoutingConfig([
      externalRoute({
        definitionId: 'external-second',
        toolName: 'second_tool',
        endpointUrl:
          'http://second-user:second-password@second.example.test:8080/second?access=second-query#ignored-fragment',
        requestStage: { mode: 'direct' },
        responseStage: { mode: 'canonical-filter', processor: 'body-codec' },
      }),
      mcpRoute({
        definitionId: 'external-mcp',
        toolName: 'mcp_tool',
        serverUrl:
          'https://mcp-user:mcp-password@mcp.example.test:8443/mcp?token=mcp-query-secret#fragment-secret',
      }),
      externalRoute({
        definitionId: 'external-first',
        toolName: 'first_tool',
        endpointUrl:
          'https://route-user:route-password@external.example.test:8443/tool?access=redacted-query',
        requestStage: {
          mode: 'body-encoder',
          processor: 'body-codec',
          contentType: 'application/octet-stream',
        },
        responseStage: { mode: 'body-decoder', processor: 'body-codec' },
      }),
    ]),
  ).join('\n');

  assertEqual(
    summary,
    [
      '  External routing: enabled',
      '    Routes: 3',
      '    Route: external-second',
      '      Routing mode: http',
      '      Tool: second_tool',
      '      Request stages: direct',
      '      Response stages: canonical-filter',
      '      Endpoint: http://second.example.test:8080/second',
      '    Route: external-mcp',
      '      Routing mode: mcp',
      '      Tool: mcp_tool',
      '      Server: https://mcp.example.test:8443/mcp',
      '    Route: external-first',
      '      Routing mode: http',
      '      Tool: first_tool',
      '      Request stages: body-encoder',
      '      Response stages: body-decoder',
      '      Endpoint: https://external.example.test:8443/tool',
    ].join('\n'),
    'External routing startup logging should use stable route order and only safe route identities',
  );
  for (const excludedValue of [
    'route-user',
    'route-password',
    'redacted-query',
    'second-user',
    'second-password',
    'second-query',
    'ignored-fragment',
    'header-value-not-for-startup',
    'mcp-user',
    'mcp-password',
    'mcp-query-secret',
    'fragment-secret',
    'mcp-header-secret',
    'X-Test-Secret',
    'mcp-value-secret',
    'shared-server.json',
    'external-mcp-server.json',
    'C:\\RouteConfig\\external-routing.json',
    'C:\\RouteConfig\\processor.json',
    'C:\\RouteConfig\\external-first-endpoint.json',
    'C:\\RouteProcessors\\body-codec.exe',
    '--processor-argument-not-for-startup',
  ]) {
    assertNotIncludes(
      summary,
      excludedValue,
      `External routing startup summary must not include ${excludedValue}`,
    );
  }
}

function testFormatsDisabledExternalRouting(): void {
  assertEqual(
    formatExternalRoutingStartupLines(undefined).join('\n'),
    '  External routing: disabled',
    'Missing external routing config should be explicitly identified as disabled',
  );
}

function testFormatsConfiguredExternalRoutingWithoutRoutes(): void {
  assertEqual(
    formatExternalRoutingStartupLines(externalRoutingConfig([])).join('\n'),
    ['  External routing: configured', '    Routes: 0'].join('\n'),
    'A compiled routing config without routes should be identified as configured rather than enabled',
  );
}

function testDoesNotExposeMalformedEndpointInput(): void {
  const summary = formatExternalRoutingStartupLines(
    externalRoutingConfig([
      externalRoute({
        definitionId: 'external-malformed',
        toolName: 'malformed_tool',
        endpointUrl: 'not a valid endpoint',
        requestStage: { mode: 'direct' },
        responseStage: { mode: 'direct' },
      }),
    ]),
  ).join('\n');

  assertEqual(
    summary,
    [
      '  External routing: enabled',
      '    Routes: 1',
      '    Route: external-malformed',
      '      Routing mode: http',
      '      Tool: malformed_tool',
      '      Request stages: direct',
      '      Response stages: direct',
      '      Endpoint: unavailable',
    ].join('\n'),
    'Malformed endpoint input should use a safe fallback rather than the raw value',
  );
  assertNotIncludes(
    summary,
    'not a valid endpoint',
    'Malformed endpoint input must not be copied into startup logs',
  );
}

function testDoesNotExposeMalformedMcpServerInput(): void {
  const summary = formatExternalRoutingStartupLines(
    externalRoutingConfig([
      mcpRoute({
        definitionId: 'external-malformed-mcp',
        toolName: 'malformed_mcp_tool',
        serverUrl: 'not a valid MCP server secret',
      }),
    ]),
  ).join('\n');
  assertEqual(
    summary,
    [
      '  External routing: enabled',
      '    Routes: 1',
      '    Route: external-malformed-mcp',
      '      Routing mode: mcp',
      '      Tool: malformed_mcp_tool',
      '      Server: unavailable',
    ].join('\n'),
    'Malformed server input should use a safe fallback',
  );
  assertNotIncludes(
    summary,
    'not a valid MCP server secret',
    'Raw server URL must not enter startup logs',
  );
}

function testFormatsRootSpecificPolicyFiles(): void {
  const lines = formatFileAccessPolicyStartupLines([
    {
      rootDir: 'E:\\Workspace',
      ignoreFiles: ['C:\\Policies\\base.ignore', 'C:\\Policies\\base.ignore'],
      denyFiles: ['C:\\Policies\\project.deny'],
    },
    {
      rootDir: 'E:\\Additional',
      ignoreFiles: [],
      denyFiles: ['C:\\Policies\\additional.deny'],
    },
  ]);

  assertEqual(
    lines.join('\n'),
    [
      '  File access policies:',
      '    Primary root: E:\\Workspace',
      '      Ignore files:',
      '        - C:\\Policies\\base.ignore',
      '        - C:\\Policies\\base.ignore',
      '      Deny files:',
      '        - C:\\Policies\\project.deny',
      '    Additional root: E:\\Additional',
      '      Ignore files: none',
      '      Deny files:',
      '        - C:\\Policies\\additional.deny',
    ].join('\n'),
    'Startup policy logging should preserve root association, order, and duplicates',
  );
}

function testFormatsEmptyPolicyState(): void {
  const lines = formatFileAccessPolicyStartupLines([
    {
      rootDir: 'E:\\Workspace',
      ignoreFiles: [],
      denyFiles: [],
    },
  ]);

  assertEqual(
    lines.join('\n'),
    '  File access policies: none',
    'Startup policy logging should explicitly identify an empty policy configuration',
  );
}

function testFormatsCompleteApplicationSummary(): void {
  const snapshot = createTestRuntimeConfigSnapshot({
    rootDir: path.join(process.cwd(), 'src'),
    otherRootDirs: [path.join(process.cwd(), 'test')],
    host: '::1',
    port: 4321,
  });
  assertEqual(
    formatApplicationStartupLines(snapshot, undefined, 'workspace.log').join('\n'),
    [
      'MCP Replace Server started',
      '  Bind address: [::1]:4321',
      '  Endpoint: http://[::1]:4321/mcp',
      `  Workspace id: ${snapshot.workspaceId}`,
      `  Snapshot version: ${snapshot.snapshotVersion}`,
      `  Global config file: ${snapshot.globalConfigFilePath}`,
      `  Workspace config file: ${snapshot.workspaceConfigFilePath}`,
      `  Primary root: ${snapshot.pathSafetyContext.primaryRoot.rootDir}`,
      '  Additional roots:',
      ...snapshot.pathSafetyContext.allowedRoots
        .filter((root) => root.kind === 'additional')
        .map((root) => `    - ${root.rootDir}`),
      '  File access policies: none',
      '  External routing: disabled',
      `  Line ending: ${snapshot.lineEnding}`,
      '  Log file: workspace.log',
    ].join('\n'),
    'Complete startup summary should preserve line order, IPv6 formatting, and workspace details',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing startup logging',
    tests: [
      {
        name: 'formats complete application summary',
        run: testFormatsCompleteApplicationSummary,
      },
      {
        name: 'formats stable safe multi-route external routing summary',
        run: testFormatsStableSafeMultiRouteExternalRoutingSummary,
      },
      {
        name: 'formats disabled external routing',
        run: testFormatsDisabledExternalRouting,
      },
      {
        name: 'formats configured external routing without routes',
        run: testFormatsConfiguredExternalRoutingWithoutRoutes,
      },
      {
        name: 'does not expose malformed external endpoint input',
        run: testDoesNotExposeMalformedEndpointInput,
      },
      {
        name: 'does not expose malformed downstream MCP server input',
        run: testDoesNotExposeMalformedMcpServerInput,
      },
      {
        name: 'formats root-specific policy files',
        run: testFormatsRootSpecificPolicyFiles,
      },
      {
        name: 'formats empty policy state',
        run: testFormatsEmptyPolicyState,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
import * as path from 'node:path';

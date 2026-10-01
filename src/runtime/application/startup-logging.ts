import type { RuntimeConfigSnapshot } from '../../config.js';
import type { RootFileAccessPolicyFiles } from '../../config/file-access-policy.js';
import type { CompiledExternalRoutingConfig } from '../../tools/external-routing/config.js';
import { buildHttpUrl, formatHostPort } from '../../utils/http-url.js';

/** Formats the complete listener-ready summary using the fixed workspace snapshot. */
export function formatApplicationStartupLines(
  snapshot: RuntimeConfigSnapshot,
  externalRoutingConfig: CompiledExternalRoutingConfig | undefined,
  logFile: string,
): readonly string[] {
  const primaryRoot = snapshot.pathSafetyContext.primaryRoot.rootDir;
  const additionalRoots = snapshot.pathSafetyContext.allowedRoots
    .filter((root) => root.kind === 'additional')
    .map((root) => root.rootDir);

  return [
    'MCP Replace Server started',
    `  Bind address: ${formatHostPort(snapshot.host, snapshot.port)}`,
    `  Endpoint: ${buildHttpUrl(snapshot.host, snapshot.port, '/mcp')}`,
    `  Workspace id: ${snapshot.workspaceId}`,
    `  Snapshot version: ${snapshot.snapshotVersion}`,
    `  Global config file: ${snapshot.globalConfigFilePath}`,
    `  Workspace config file: ${snapshot.workspaceConfigFilePath}`,
    `  Primary root: ${primaryRoot}`,
    ...(additionalRoots.length === 0
      ? ['  Additional roots: none']
      : [
          '  Additional roots:',
          ...additionalRoots.map((rootDir) => `    - ${rootDir}`),
        ]),
    ...formatFileAccessPolicyStartupLines(snapshot.fileAccessPolicyFiles),
    ...formatExternalRoutingStartupLines(externalRoutingConfig),
    `  Line ending: ${snapshot.lineEnding}`,
    `  Log file: ${logFile}`,
  ];
}

/**
 * Formats startup-safe route identities without configuration source paths,
 * Processor details, headers, or endpoint query and credential material.
 */
export function formatExternalRoutingStartupLines(
  config: CompiledExternalRoutingConfig | undefined,
): readonly string[] {
  if (config === undefined) {
    return ['  External routing: disabled'];
  }

  const routes = config.routes;
  if (routes.length === 0) {
    return [
      '  External routing: configured',
      '    Routes: 0',
    ];
  }

  const lines = [
    '  External routing: enabled',
    `    Routes: ${routes.length}`,
  ];
  for (const route of routes) {
    lines.push(
      `    Route: ${route.definitionId}`,
      `      Routing mode: ${route.routingMode}`,
      `      Tool: ${route.toolName}`,
    );
    if (route.routingMode === 'http') {
      lines.push(
        `      Request stages: ${route.requestStage.mode}`,
        `      Response stages: ${route.responseStage.mode}`,
        `      Endpoint: ${formatExternalRoutingEndpointIdentity(route.endpoint.url)}`,
      );
    } else {
      lines.push(`      Server: ${formatExternalRoutingEndpointIdentity(route.server.url)}`);
    }
  }
  return lines;
}

export function formatFileAccessPolicyStartupLines(
  roots: readonly RootFileAccessPolicyFiles[],
): readonly string[] {
  const hasConfiguredPolicyFiles = roots.some(
    (root) => root.ignoreFiles.length > 0 || root.denyFiles.length > 0,
  );
  if (!hasConfiguredPolicyFiles) {
    return ['  File access policies: none'];
  }

  const lines = ['  File access policies:'];
  roots.forEach((root, index) => {
    const rootLabel = index === 0 ? 'Primary root' : 'Additional root';
    lines.push(`    ${rootLabel}: ${root.rootDir}`);
    appendPolicyFileLines(lines, 'Ignore files', root.ignoreFiles);
    appendPolicyFileLines(lines, 'Deny files', root.denyFiles);
  });
  return lines;
}

function appendPolicyFileLines(
  lines: string[],
  label: string,
  policyFiles: readonly string[],
): void {
  if (policyFiles.length === 0) {
    lines.push(`      ${label}: none`);
    return;
  }

  lines.push(`      ${label}:`);
  for (const policyFile of policyFiles) {
    lines.push(`        - ${policyFile}`);
  }
}

function formatExternalRoutingEndpointIdentity(endpointUrl: string): string {
  try {
    const endpoint = new URL(endpointUrl);
    endpoint.username = '';
    endpoint.password = '';
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.toString();
  } catch {
    // The validated routing snapshot always has a valid HTTP(S) URL. Keep this
    // defensive fallback safe if a caller violates that runtime contract.
    return 'unavailable';
  }
}

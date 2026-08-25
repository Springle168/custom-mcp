import type { RootFileAccessPolicyFiles } from '../config/file-access-policy.js';
import type { CompiledExternalRoutingConfig } from '../tools/external-routing/config.js';

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

  const routes = [...config.routesByDefinitionId.values()];
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
      `      Tool: ${route.toolName}`,
      `      Request stages: ${route.requestStage.mode}`,
      `      Response stages: ${route.responseStage.mode}`,
      `      Endpoint: ${formatExternalRoutingEndpointIdentity(route.endpoint.url)}`,
    );
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

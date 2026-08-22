import type { RootFileAccessPolicyFiles } from '../config/file-access-policy.js';
import type { ExternalRoutingSpec } from '../tools/external-routing/config.js';

/**
 * Formats the startup-safe identity and strategy summary for the optional
 * external route. Configuration source paths, Processor commands/arguments,
 * headers, and endpoint query/credentials must stay out of startup logs.
 */
export function formatExternalRoutingStartupLines(
  route: ExternalRoutingSpec | undefined,
): readonly string[] {
  if (route === undefined) {
    return ['  External routing: disabled'];
  }

  return [
    '  External routing: enabled',
    `    Request mode: ${route.requestStrategy.mode}`,
    `    Response mode: ${route.responseStrategy.mode}`,
    `    Endpoint: ${formatExternalRoutingEndpointIdentity(route.endpoint.url)}`,
  ];
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

import type { RootFileAccessPolicyFiles } from '../config/file-access-policy.js';

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

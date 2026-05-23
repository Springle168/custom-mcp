import { isAbsolute, resolve, sep } from 'node:path';

export interface WorkspaceConfig {
  rootDir: string;
  otherRootDirs?: readonly string[];
}

export function getAllowedRootDirs(config: WorkspaceConfig): string[] {
  return [config.rootDir, ...(config.otherRootDirs ?? [])];
}

export function isWindowsDriveRelativePath(filePath: string): boolean {
  return /^[a-zA-Z]:(?![\\/])/.test(filePath);
}

export function isWindowsRootedPathWithoutDrive(filePath: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  const normalized = filePath.replace(/\//g, '\\');
  return normalized.startsWith('\\') && !normalized.startsWith('\\\\');
}

export function isAbsoluteInputPath(filePath: string): boolean {
  if (
    isWindowsDriveRelativePath(filePath) ||
    isWindowsRootedPathWithoutDrive(filePath)
  ) {
    return false;
  }

  return isAbsolute(filePath) || filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath);
}

export function getAccessRootDirsForPath(
  filePath: string,
  config: WorkspaceConfig,
): string[] {
  return isAbsoluteInputPath(filePath)
    ? getAllowedRootDirs(config)
    : [config.rootDir];
}

export function resolvePath(filePath: string, rootDir: string): string {
  // 绝对路径直接 normalize，相对路径基于 rootDir 解析
  if (isAbsoluteInputPath(filePath)) {
    return resolve(filePath);
  }
  if (isWindowsDriveRelativePath(filePath)) {
    return resolve(rootDir, filePath.slice(2));
  }
  if (isWindowsRootedPathWithoutDrive(filePath)) {
    return resolve(rootDir, filePath.replace(/^[\\/]+/, ''));
  }
  return resolve(rootDir, filePath);
}

function normalizeRoots(rootDirs: string | readonly string[]): string[] {
  return typeof rootDirs === 'string' ? [rootDirs] : [...rootDirs];
}

function isPathWithinRoot(normalizedPath: string, normalizedRoot: string): boolean {
  const rootPrefix = normalizedRoot + sep;

  if (process.platform === 'win32') {
    // Windows 文件系统大小写不敏感
    return (
      normalizedPath.toLowerCase() === normalizedRoot.toLowerCase() ||
      normalizedPath.toLowerCase().startsWith(rootPrefix.toLowerCase())
    );
  }

  return normalizedPath === normalizedRoot || normalizedPath.startsWith(rootPrefix);
}

export function findContainingRoot(
  resolvedPath: string,
  rootDirs: string | readonly string[],
): string | null {
  const normalizedPath = resolve(resolvedPath);
  const matches = normalizeRoots(rootDirs)
    .map((rootDir) => ({ rootDir, normalizedRoot: resolve(rootDir) }))
    .filter(({ normalizedRoot }) => isPathWithinRoot(normalizedPath, normalizedRoot))
    .sort((a, b) => b.normalizedRoot.length - a.normalizedRoot.length);

  return matches[0]?.rootDir ?? null;
}

export function validatePathAccess(
  resolvedPath: string,
  rootDirs: string | readonly string[],
): string | null {
  if (!findContainingRoot(resolvedPath, rootDirs)) {
    const formattedRootDirs = normalizeRoots(rootDirs).join(', ');
    return `Path ${resolvedPath} is outside the allowed workspace(s): ${formattedRootDirs}.`;
  }
  return null;
}

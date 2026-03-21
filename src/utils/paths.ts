import { resolve, sep } from 'node:path';

export function resolvePath(filePath: string, rootDir: string): string {
  // 绝对路径直接 normalize，相对路径基于 rootDir 解析
  if (filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)) {
    return resolve(filePath);
  }
  return resolve(rootDir, filePath);
}

export function validatePathAccess(
  resolvedPath: string,
  rootDir: string,
): string | null {
  const normalizedRoot = resolve(rootDir);
  const normalizedPath = resolve(resolvedPath);
  const rootPrefix = normalizedRoot + sep;

  let isWithin: boolean;
  if (process.platform === 'win32') {
    // Windows 文件系统大小写不敏感
    isWithin =
      normalizedPath.toLowerCase() === normalizedRoot.toLowerCase() ||
      normalizedPath.toLowerCase().startsWith(rootPrefix.toLowerCase());
  } else {
    isWithin =
      normalizedPath === normalizedRoot ||
      normalizedPath.startsWith(rootPrefix);
  }

  if (!isWithin) {
    return `Path ${resolvedPath} is outside the allowed workspace ${rootDir}.`;
  }
  return null;
}

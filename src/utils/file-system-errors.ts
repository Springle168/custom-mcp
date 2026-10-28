/** Reads only errno identity; exception text and OS paths are never public reasons. */
export function getFileSystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Produces a controlled, path-free reason. Callers own operation context and any
 * approved display path; classification and policy failures stay separate.
 */
export function fileSystemErrorReason(error: unknown): string {
  switch (getFileSystemErrorCode(error)) {
    case 'ENOENT':
      return 'file not found';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'ENOTDIR':
      return 'a path component is not a directory';
    case 'EISDIR':
      return 'target is a directory';
    case 'EEXIST':
      return 'target already exists';
    case 'ENAMETOOLONG':
      return 'path is too long';
    case 'ELOOP':
      return 'too many symbolic links';
    case 'EBUSY':
    case 'ETXTBSY':
      return 'file or directory is busy';
    case 'ENOSPC':
      return 'no space left on device';
    case 'EDQUOT':
      return 'storage quota exceeded';
    case 'EROFS':
      return 'file system is read-only';
    case 'EMFILE':
    case 'ENFILE':
      return 'too many open files';
    case 'EIO':
      return 'file system input/output error';
    case 'EINVAL':
      return 'invalid file system argument';
    default:
      return 'file system operation failed';
  }
}

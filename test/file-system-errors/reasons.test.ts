import {
  fileSystemErrorReason,
  getFileSystemErrorCode,
} from '../../src/utils/file-system-errors.js';
import { assertEqual, runTestSuite } from '../test-utils.js';

const REASONS = [
  ['ENOENT', 'file not found'],
  ['EACCES', 'permission denied'],
  ['EPERM', 'permission denied'],
  ['ENOTDIR', 'a path component is not a directory'],
  ['EISDIR', 'target is a directory'],
  ['EEXIST', 'target already exists'],
  ['ENAMETOOLONG', 'path is too long'],
  ['ELOOP', 'too many symbolic links'],
  ['EBUSY', 'file or directory is busy'],
  ['ETXTBSY', 'file or directory is busy'],
  ['ENOSPC', 'no space left on device'],
  ['EDQUOT', 'storage quota exceeded'],
  ['EROFS', 'file system is read-only'],
  ['EMFILE', 'too many open files'],
  ['ENFILE', 'too many open files'],
  ['EIO', 'file system input/output error'],
  ['EINVAL', 'invalid file system argument'],
] as const;

await runTestSuite({
  title: 'Controlled file system error reasons',
  tests: [
    {
      name: 'Known errno values have stable, path-free reasons',
      run: () => {
        for (const [code, reason] of REASONS) {
          const error = Object.assign(new Error('private-message'), {
            code,
            path: 'private-path',
            dest: 'private-destination',
            syscall: 'private-syscall',
            stack: 'private-stack',
          });
          assertEqual(fileSystemErrorReason(error), reason, `${code}: controlled reason`);
          assertEqual(getFileSystemErrorCode(error), code, `${code}: preserve errno identity`);
        }
      },
    },
    {
      name: 'Unknown errors never stringify arbitrary values',
      run: () => {
        for (const error of [
          null,
          undefined,
          'private-string',
          42,
          new Error('private-message'),
          { code: 2 },
          { code: 'PRIVATE_UNKNOWN_CODE', message: 'private-message' },
          {
            toString: () => {
              throw new Error('must not stringify');
            },
          },
        ]) {
          assertEqual(
            fileSystemErrorReason(error),
            'file system operation failed',
            'Unknown values use the fixed fallback',
          );
        }
      },
    },
    {
      name: 'Only code is inspected, never message, path, destination, syscall, or stack',
      run: () => {
        const error: Record<string, unknown> = { code: 'EACCES' };
        for (const key of ['message', 'path', 'dest', 'syscall', 'stack']) {
          Object.defineProperty(error, key, {
            get: () => {
              throw new Error(`Must not inspect ${key}`);
            },
          });
        }
        assertEqual(fileSystemErrorReason(error), 'permission denied', 'Metadata stays untouched');
      },
    },
  ],
});

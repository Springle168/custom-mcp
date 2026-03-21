/**
 * 基于 Promise 链的按文件路径并发锁。
 * 同一文件的操作顺序执行，不同文件互不阻塞。
 */
const locks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = filePath.toLowerCase();

  // 拿到当前文件上一个操作的 Promise（如果有的话）
  const previousLock = locks.get(key) ?? Promise.resolve();

  // 创建本次操作的锁
  let releaseLock: () => void;
  const currentLock = new Promise<void>((r) => {
    releaseLock = r;
  });
  locks.set(key, currentLock);

  // 等前一个操作完成
  await previousLock;

  try {
    return await fn();
  } finally {
    releaseLock!();
    // 如果自己是链上最后一个，清理掉
    if (locks.get(key) === currentLock) {
      locks.delete(key);
    }
  }
}

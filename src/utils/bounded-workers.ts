/**
 * Maps with bounded concurrency and stable result positions. On cancellation or an
 * unexpected task failure, stops claiming work and drains all started tasks before
 * rejecting; the task retains ownership of its resources and cleanup.
 */
export async function mapWithWorkers<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  processItem: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Worker concurrency must be a positive integer.');
  }
  signal.throwIfAborted();

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;

  async function worker(): Promise<void> {
    while (!failed && !signal.aborted && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await processItem(items[index]!, index);
      } catch (error: unknown) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  signal.throwIfAborted();
  if (failed) throw failure;
  return results;
}

/** Per-call concurrency for file-reading tools, not a shared global worker pool. */
export const FILE_READ_CONCURRENCY = 8;

/** Maximum complete source file size in MiB, including for range reads. */
export const MAX_FILE_SIZE_MB = 20;

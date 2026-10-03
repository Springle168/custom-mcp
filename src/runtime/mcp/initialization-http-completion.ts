import type { Request, Response } from 'express';

/** Public Node events distinguish response completion from client interruption. */
export function observeInitializationHttpCompletion(
  req: Request,
  res: Response,
): {
  readonly completed: Promise<boolean>;
  readonly interrupted: Promise<void>;
  dispose(): void;
} {
  let resolveCompleted!: (normal: boolean) => void;
  let resolveInterrupted!: () => void;
  const completed = new Promise<boolean>((resolve) => {
    resolveCompleted = resolve;
  });
  const interrupted = new Promise<void>((resolve) => {
    resolveInterrupted = resolve;
  });
  const finish = () => {
    resolveCompleted(true);
  };
  const abort = () => {
    resolveCompleted(false);
    resolveInterrupted();
  };
  const close = () => {
    if (res.writableFinished) {
      finish();
    } else {
      abort();
    }
  };
  res.on('finish', finish);
  res.on('close', close);
  res.on('error', abort);
  req.on('aborted', abort);
  if (req.aborted || (res.destroyed && !res.writableFinished)) {
    abort();
  } else if (res.writableFinished) {
    finish();
  }
  return {
    completed,
    interrupted,
    dispose() {
      res.off('finish', finish);
      res.off('close', close);
      res.off('error', abort);
      req.off('aborted', abort);
    },
  };
}

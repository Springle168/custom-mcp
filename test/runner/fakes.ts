import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

/** Event-only child: no OS process is created and kill never reaches the OS. */
export function fakeChild(pid = 4321): {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  kills: Array<NodeJS.Signals | number | undefined>;
  isDetached: () => boolean;
} {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  let detached = false;
  Object.defineProperties(child, {
    pid: { value: pid },
    stdout: { value: stdout },
    stderr: { value: stderr },
  });
  child.kill = (signal): boolean => {
    kills.push(signal);
    return true;
  };
  child.unref = (): void => {
    detached = true;
  };
  return { child, stdout, stderr, kills, isDetached: () => detached };
}

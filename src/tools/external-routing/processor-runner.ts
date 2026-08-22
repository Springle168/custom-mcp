import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Buffer } from 'node:buffer';
import type { Readable, Writable } from 'node:stream';

/** The fixed v1 upper bound for a Processor input or output byte stream. */
export const PROCESSOR_STREAM_LIMIT_BYTES = 50 * 1024 * 1024;

/** The fixed v1 upper bound for retained Processor stderr diagnostics. */
export const PROCESSOR_STDERR_CAPTURE_LIMIT_BYTES = 1024 * 1024;

const DEFAULT_TERMINATION_GRACE_PERIOD_MS = 250;
const DEFAULT_FORCE_TERMINATION_GRACE_PERIOD_MS = 250;

type RequestProcessorRole =
  | 'request.canonical-filter'
  | 'request.body-encoder';
type ResponseProcessorRole =
  | 'response.canonical-filter'
  | 'response.body-decoder';

/**
 * Metadata explicitly supplied by a request-side strategy. Response-only
 * representation fields are deliberately unavailable for these roles.
 */
export interface RequestProcessorInvocationEnvironment {
  readonly role: RequestProcessorRole;
  readonly callId: string;
}

/**
 * Metadata explicitly supplied by a response-side strategy. The runner copies
 * only these safe correlation and representation values into the child env.
 */
export interface ResponseProcessorInvocationEnvironment {
  readonly role: ResponseProcessorRole;
  readonly callId: string;
  readonly httpStatus: number;
  readonly contentType?: string;
  readonly contentEncoding?: string;
}

export type ProcessorInvocationEnvironment =
  | RequestProcessorInvocationEnvironment
  | ResponseProcessorInvocationEnvironment;

/** A strategy-owned description of the one-shot subprocess to start. */
export interface ProcessorInvocation {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly timeoutMs: number;
  readonly stdin: Uint8Array;
  readonly environment: ProcessorInvocationEnvironment;
  readonly signal?: AbortSignal;
}

export type ProcessorRunnerFailureReason =
  | 'runner_closed'
  | 'stdin_limit'
  | 'spawn_error'
  | 'stdio_error'
  | 'exit_code'
  | 'signal'
  | 'stdout_limit'
  | 'timeout'
  | 'cancelled';

/** Safe byte-count diagnostics that never expose captured stderr content. */
export interface ProcessorStderrMetadata {
  readonly byteCount: number;
  readonly capturedByteCount: number;
  readonly truncated: boolean;
}

export interface ProcessorRunMetadata {
  readonly durationMs: number;
  readonly stdinBytes: number;
  readonly stdoutBytes: number;
  readonly stderr: ProcessorStderrMetadata;
}

export interface ProcessorRunSuccess extends ProcessorRunMetadata {
  readonly kind: 'success';
  /** Bytes intentionally handed back to the calling strategy for validation. */
  readonly stdout: Uint8Array;
}

export interface ProcessorRunFailure extends ProcessorRunMetadata {
  readonly kind: 'failure';
  readonly reason: ProcessorRunnerFailureReason;
}

export type ProcessorRunOutcome = ProcessorRunSuccess | ProcessorRunFailure;

/**
 * Physical cleanup completion for a Processor invocation. This resolves after
 * the direct child closes or after bounded degraded cleanup detaches it.
 */
export interface ProcessorRunDrainMetadata {
  readonly durationMs: number;
  /**
   * True only when the direct child did not confirm `close` within bounded
   * termination. The runner then permanently rejects future admissions.
   */
  readonly cleanupFailed: boolean;
}

/**
 * One Processor invocation has separate caller-facing settlement and local
 * resource-drain completions. A failure settles immediately; cleanup continues
 * in the background until `drained`.
 */
export interface ProcessorRunExchange {
  readonly settled: Promise<ProcessorRunOutcome>;
  readonly drained: Promise<ProcessorRunDrainMetadata>;
}

export interface ProcessorRunnerOptions {
  /** Internal bounded wait before the direct child receives a forceful kill. */
  readonly terminationGracePeriodMs?: number;
  /** Internal bounded wait after the forceful kill before cleanup is degraded. */
  readonly forceTerminationGracePeriodMs?: number;
}

type PipedChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * Owns one-shot Processor subprocesses only. It does not inspect canonical
 * documents or HTTP data; strategy adapters own those contracts.
 */
export class ProcessorRunner {
  readonly #terminationGracePeriodMs: number;
  readonly #forceTerminationGracePeriodMs: number;
  readonly #activeInvocations = new Set<ActiveProcessorInvocation>();
  #accepting = true;
  #closePromise: Promise<void> | undefined;

  constructor(options: ProcessorRunnerOptions = {}) {
    this.#terminationGracePeriodMs = readPositiveDuration(
      options.terminationGracePeriodMs,
      DEFAULT_TERMINATION_GRACE_PERIOD_MS,
    );
    this.#forceTerminationGracePeriodMs = readPositiveDuration(
      options.forceTerminationGracePeriodMs,
      DEFAULT_FORCE_TERMINATION_GRACE_PERIOD_MS,
    );
  }

  /** Active subprocess invocations, including ones still performing cleanup. */
  get activeInvocationCount(): number {
    return this.#activeInvocations.size;
  }

  /**
   * Starts a single bytes-in/bytes-out Processor invocation. Failure outcomes
   * settle as soon as their terminal reason is known; `drained` completes
   * separately after local subprocess cleanup.
   */
  run(invocation: ProcessorInvocation): ProcessorRunExchange {
    const startedAt = Date.now();
    const stdinBytes = invocation.stdin.byteLength;

    if (!this.#accepting) {
      return createImmediateExchange('runner_closed', startedAt, stdinBytes);
    }

    if (stdinBytes > PROCESSOR_STREAM_LIMIT_BYTES) {
      return createImmediateExchange('stdin_limit', startedAt, stdinBytes);
    }

    if (invocation.signal?.aborted === true) {
      return createImmediateExchange('cancelled', startedAt, stdinBytes);
    }

    const active = new ActiveProcessorInvocation(
      invocation,
      startedAt,
      this.#terminationGracePeriodMs,
      this.#forceTerminationGracePeriodMs,
      () => {
        this.#accepting = false;
      },
    );
    this.#activeInvocations.add(active);

    const exchange = active.start();
    void exchange.drained.then(() => {
      this.#activeInvocations.delete(active);
    });
    return exchange;
  }

  /**
   * Stops future admission, cancels all active local subprocess waits, and
   * resolves once each invocation has completed bounded local cleanup.
   */
  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#accepting = false;
    const active = [...this.#activeInvocations];
    for (const invocation of active) {
      invocation.cancel();
    }

    this.#closePromise = Promise.all(active.map((invocation) => invocation.drained))
      .then(() => undefined);
    return this.#closePromise;
  }
}

class ActiveProcessorInvocation {
  readonly exchange: ProcessorRunExchange;
  readonly settled: Promise<ProcessorRunOutcome>;
  readonly drained: Promise<ProcessorRunDrainMetadata>;
  readonly #invocation: ProcessorInvocation;
  readonly #startedAt: number;
  readonly #terminationGracePeriodMs: number;
  readonly #forceTerminationGracePeriodMs: number;
  readonly #closeRunnerAdmission: () => void;
  readonly #stdoutChunks: Buffer[] = [];
  readonly #stderrChunks: Buffer[] = [];
  #resolveSettled: ((outcome: ProcessorRunOutcome) => void) | undefined;
  #resolveDrained: ((metadata: ProcessorRunDrainMetadata) => void) | undefined;
  #child: PipedChildProcess | undefined;
  #stdin: Writable | undefined;
  #stdout: Readable | undefined;
  #stderr: Readable | undefined;
  #terminalReason: ProcessorRunnerFailureReason | undefined;
  #settledResolved = false;
  #drainedResolved = false;
  #spawned = false;
  #spawnFailed = false;
  #childClosed = false;
  #exitCode: number | null = null;
  #exitSignal: NodeJS.Signals | null = null;
  #stdinWriteCompleted = false;
  #stdoutEnded = false;
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #stderrCapturedBytes = 0;
  #cleanupFailed = false;
  #wallClockTimer: NodeJS.Timeout | undefined;
  #terminationTimer: NodeJS.Timeout | undefined;
  #forceTerminationTimer: NodeJS.Timeout | undefined;
  #abortListener: (() => void) | undefined;

  #onChildSpawn = (): void => {
    this.#spawned = true;
  };

  #onChildError = (): void => {
    this.#spawnFailed = !this.#spawned;
    this.#fail(this.#spawnFailed ? 'spawn_error' : 'stdio_error');
  };

  #onChildClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    this.#childClosed = true;
    this.#exitCode = exitCode;
    this.#exitSignal = signal;

    if (this.#terminalReason) {
      this.#finishDrain(false);
      return;
    }

    if (signal !== null) {
      this.#fail('signal');
      return;
    }

    if (exitCode !== 0) {
      this.#fail('exit_code');
      return;
    }

    this.#succeedWhenComplete();
  };

  #onStdinError = (): void => {
    this.#fail('stdio_error');
  };

  #onStdinClose = (): void => {
    if (!this.#stdinWriteCompleted && !this.#terminalReason) {
      this.#fail('stdio_error');
    }
  };

  #onStdoutData = (chunk: Buffer): void => {
    if (this.#drainedResolved || this.#terminalReason) {
      return;
    }

    this.#stdoutBytes += chunk.byteLength;
    if (this.#stdoutBytes > PROCESSOR_STREAM_LIMIT_BYTES) {
      this.#fail('stdout_limit');
      return;
    }

    this.#stdoutChunks.push(Buffer.from(chunk));
  };

  #onStdoutEnd = (): void => {
    this.#stdoutEnded = true;
    this.#succeedWhenComplete();
  };

  #onStdoutClose = (): void => {
    if (!this.#stdoutEnded && !this.#terminalReason) {
      this.#fail('stdio_error');
    }
  };

  #onStdoutError = (): void => {
    this.#fail('stdio_error');
  };

  #onStderrData = (chunk: Buffer): void => {
    if (this.#drainedResolved) {
      return;
    }

    this.#stderrBytes += chunk.byteLength;
    if (this.#terminalReason) {
      return;
    }

    const remainingCaptureBytes = PROCESSOR_STDERR_CAPTURE_LIMIT_BYTES - this.#stderrCapturedBytes;
    if (remainingCaptureBytes <= 0) {
      return;
    }

    const capturedChunk = chunk.byteLength <= remainingCaptureBytes
      ? chunk
      : chunk.subarray(0, remainingCaptureBytes);
    this.#stderrChunks.push(Buffer.from(capturedChunk));
    this.#stderrCapturedBytes += capturedChunk.byteLength;
  };

  #onStderrError = (): void => {
    this.#fail('stdio_error');
  };

  constructor(
    invocation: ProcessorInvocation,
    startedAt: number,
    terminationGracePeriodMs: number,
    forceTerminationGracePeriodMs: number,
    closeRunnerAdmission: () => void,
  ) {
    this.#invocation = invocation;
    this.#startedAt = startedAt;
    this.#terminationGracePeriodMs = terminationGracePeriodMs;
    this.#forceTerminationGracePeriodMs = forceTerminationGracePeriodMs;
    this.#closeRunnerAdmission = closeRunnerAdmission;
    this.settled = new Promise<ProcessorRunOutcome>((resolve) => {
      this.#resolveSettled = resolve;
    });
    this.drained = new Promise<ProcessorRunDrainMetadata>((resolve) => {
      this.#resolveDrained = resolve;
    });
    this.exchange = {
      settled: this.settled,
      drained: this.drained,
    };
  }

  start(): ProcessorRunExchange {
    this.#wallClockTimer = setTimeout(() => {
      this.#fail('timeout');
    }, this.#invocation.timeoutMs);

    if (this.#invocation.signal) {
      this.#abortListener = () => {
        this.#fail('cancelled');
      };
      this.#invocation.signal.addEventListener('abort', this.#abortListener, { once: true });
      if (this.#invocation.signal.aborted) {
        this.#fail('cancelled');
        return this.exchange;
      }
    }

    try {
      const child = spawn(this.#invocation.command, this.#invocation.arguments, {
        cwd: this.#invocation.workingDirectory,
        env: createInvocationEnvironment(this.#invocation.environment),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.#child = child;
      this.#stdin = child.stdin;
      this.#stdout = child.stdout;
      this.#stderr = child.stderr;
      this.#attachListeners(child);
      this.#writeStdin();
    } catch {
      this.#spawnFailed = true;
      this.#fail('spawn_error');
    }

    return this.exchange;
  }

  cancel(): void {
    this.#fail('cancelled');
  }

  #attachListeners(child: PipedChildProcess): void {
    child.once('spawn', this.#onChildSpawn);
    child.on('error', this.#onChildError);
    child.once('close', this.#onChildClose);
    child.stdin.on('error', this.#onStdinError);
    child.stdin.once('close', this.#onStdinClose);
    child.stdout.on('data', this.#onStdoutData);
    child.stdout.once('end', this.#onStdoutEnd);
    child.stdout.once('close', this.#onStdoutClose);
    child.stdout.on('error', this.#onStdoutError);
    child.stderr.on('data', this.#onStderrData);
    child.stderr.on('error', this.#onStderrError);
  }

  #writeStdin(): void {
    if (!this.#stdin) {
      this.#fail('stdio_error');
      return;
    }

    try {
      this.#stdin.end(this.#invocation.stdin, () => {
        this.#stdinWriteCompleted = true;
        this.#succeedWhenComplete();
      });
    } catch {
      this.#fail('stdio_error');
    }
  }

  #succeedWhenComplete(): void {
    if (
      this.#settledResolved ||
      this.#terminalReason ||
      !this.#childClosed ||
      this.#exitCode !== 0 ||
      this.#exitSignal !== null ||
      !this.#stdinWriteCompleted ||
      !this.#stdoutEnded
    ) {
      return;
    }

    this.#settleSuccess();
    this.#finishDrain(false);
  }

  #fail(reason: ProcessorRunnerFailureReason): void {
    if (this.#settledResolved || this.#terminalReason) {
      return;
    }

    this.#terminalReason = reason;
    clearTimeout(this.#wallClockTimer);
    this.#wallClockTimer = undefined;
    this.#settleFailure(reason);

    this.#destroyStdio({
      preserveOutputPipes: reason === 'timeout' || reason === 'cancelled',
    });

    if (!this.#child || this.#spawnFailed || this.#childClosed) {
      this.#finishDrain(false);
      return;
    }

    this.#terminateDirectChild();
  }

  #terminateDirectChild(): void {
    this.#sendSignal('SIGTERM');
    this.#terminationTimer = setTimeout(() => {
      if (this.#drainedResolved || this.#childClosed) {
        return;
      }

      this.#sendSignal('SIGKILL');
      this.#forceTerminationTimer = setTimeout(() => {
        if (this.#drainedResolved || this.#childClosed) {
          return;
        }

        this.#cleanupFailed = true;
        this.#closeRunnerAdmission();
        this.#detachUnconfirmedChild();
        this.#finishDrain(true);
      }, this.#forceTerminationGracePeriodMs);
    }, this.#terminationGracePeriodMs);
  }

  #sendSignal(signal: NodeJS.Signals): void {
    try {
      this.#child?.kill(signal);
    } catch {
      // A failed local kill attempt is represented by bounded cleanup, not a raw exception.
    }
  }

  /**
   * Timeout and cancellation leave output pipes flowing until child `close` so
   * a descendant that inherited stdout/stderr cannot be hidden by a local
   * destroy. Their raw bytes are discarded after settlement; final degraded
   * cleanup still destroys every local stdio handle.
   */
  #destroyStdio(options: { readonly preserveOutputPipes?: boolean } = {}): void {
    destroyStream(this.#stdin);
    if (options.preserveOutputPipes) {
      return;
    }

    destroyStream(this.#stdout);
    destroyStream(this.#stderr);
  }

  /**
   * After bounded termination has failed, this process must no longer keep an
   * unconfirmed child or its stdio handles alive. A no-op error listener stays
   * attached only to prevent a late Node.js EventEmitter error from escaping.
   */
  #detachUnconfirmedChild(): void {
    const child = this.#child;
    this.#destroyStdio();
    this.#detachListeners();

    try {
      child?.unref();
    } catch {
      // The child remains unconfirmed; bounded local cleanup still proceeds.
    }

    this.#child = undefined;
    this.#stdin = undefined;
    this.#stdout = undefined;
    this.#stderr = undefined;
  }

  #settleSuccess(): void {
    if (this.#settledResolved) {
      return;
    }

    this.#settledResolved = true;
    this.#resolveSettled?.(this.#createSuccess());
    this.#resolveSettled = undefined;
  }

  #settleFailure(reason: ProcessorRunnerFailureReason): void {
    if (this.#settledResolved) {
      return;
    }

    this.#settledResolved = true;
    this.#resolveSettled?.(this.#createFailure(reason));
    this.#resolveSettled = undefined;
  }

  #finishDrain(cleanupFailed: boolean): void {
    if (this.#drainedResolved) {
      return;
    }

    this.#drainedResolved = true;
    this.#cleanupFailed = this.#cleanupFailed || cleanupFailed;
    clearTimeout(this.#wallClockTimer);
    clearTimeout(this.#terminationTimer);
    clearTimeout(this.#forceTerminationTimer);
    this.#wallClockTimer = undefined;
    this.#terminationTimer = undefined;
    this.#forceTerminationTimer = undefined;

    if (this.#abortListener && this.#invocation.signal) {
      this.#invocation.signal.removeEventListener('abort', this.#abortListener);
    }
    this.#abortListener = undefined;

    this.#detachListeners();
    this.#stdoutChunks.length = 0;
    this.#stderrChunks.length = 0;
    this.#resolveDrained?.({
      durationMs: Date.now() - this.#startedAt,
      cleanupFailed: this.#cleanupFailed,
    });
    this.#resolveDrained = undefined;
  }

  #createSuccess(): ProcessorRunSuccess {
    return {
      kind: 'success',
      stdout: new Uint8Array(Buffer.concat(this.#stdoutChunks)),
      ...this.#metadata(),
    };
  }

  #createFailure(reason: ProcessorRunnerFailureReason): ProcessorRunFailure {
    return {
      kind: 'failure',
      reason,
      ...this.#metadata(),
    };
  }

  #metadata(): ProcessorRunMetadata {
    return {
      durationMs: Date.now() - this.#startedAt,
      stdinBytes: this.#invocation.stdin.byteLength,
      stdoutBytes: this.#stdoutBytes,
      stderr: {
        byteCount: this.#stderrBytes,
        capturedByteCount: this.#stderrCapturedBytes,
        truncated: this.#stderrBytes > PROCESSOR_STDERR_CAPTURE_LIMIT_BYTES,
      },
    };
  }

  #detachListeners(): void {
    const child = this.#child;
    if (child) {
      child.removeListener('spawn', this.#onChildSpawn);
      child.removeListener('error', this.#onChildError);
      child.removeListener('close', this.#onChildClose);
      child.on('error', ignoreError);
    }

    const stdin = this.#stdin;
    if (stdin) {
      stdin.removeListener('error', this.#onStdinError);
      stdin.removeListener('close', this.#onStdinClose);
      stdin.on('error', ignoreError);
    }

    const stdout = this.#stdout;
    if (stdout) {
      stdout.removeListener('data', this.#onStdoutData);
      stdout.removeListener('end', this.#onStdoutEnd);
      stdout.removeListener('close', this.#onStdoutClose);
      stdout.removeListener('error', this.#onStdoutError);
      stdout.on('error', ignoreError);
    }

    const stderr = this.#stderr;
    if (stderr) {
      stderr.removeListener('data', this.#onStderrData);
      stderr.removeListener('error', this.#onStderrError);
      stderr.on('error', ignoreError);
    }
  }
}

function createImmediateExchange(
  reason: ProcessorRunnerFailureReason,
  startedAt: number,
  stdinBytes: number,
): ProcessorRunExchange {
  const outcome = createImmediateFailure(reason, startedAt, stdinBytes);
  return {
    settled: Promise.resolve(outcome),
    drained: Promise.resolve({
      durationMs: outcome.durationMs,
      cleanupFailed: false,
    }),
  };
}

function createImmediateFailure(
  reason: ProcessorRunnerFailureReason,
  startedAt: number,
  stdinBytes: number,
): ProcessorRunFailure {
  return {
    kind: 'failure',
    reason,
    durationMs: Date.now() - startedAt,
    stdinBytes,
    stdoutBytes: 0,
    stderr: {
      byteCount: 0,
      capturedByteCount: 0,
      truncated: false,
    },
  };
}

function createInvocationEnvironment(
  metadata: ProcessorInvocationEnvironment,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };

  for (const name of Object.keys(environment)) {
    const normalizedName = name.toUpperCase();
    if (
      normalizedName === 'CUSTOM_MCP_PROCESSOR_ROLE' ||
      normalizedName.startsWith('CUSTOM_MCP_EXTERNAL_')
    ) {
      delete environment[name];
    }
  }

  environment.CUSTOM_MCP_PROCESSOR_ROLE = metadata.role;
  environment.CUSTOM_MCP_EXTERNAL_CALL_ID = metadata.callId;

  if ('httpStatus' in metadata) {
    environment.CUSTOM_MCP_EXTERNAL_HTTP_STATUS = String(metadata.httpStatus);
    if (metadata.contentType !== undefined) {
      environment.CUSTOM_MCP_EXTERNAL_CONTENT_TYPE = metadata.contentType;
    }
    if (metadata.contentEncoding !== undefined) {
      environment.CUSTOM_MCP_EXTERNAL_CONTENT_ENCODING = metadata.contentEncoding;
    }
  }

  return environment;
}

function destroyStream(stream: Writable | Readable | undefined): void {
  if (!stream || stream.destroyed) {
    return;
  }

  stream.destroy();
}

function ignoreError(): void {
  // A detached stdio handle can still report a late local error; it has no caller-facing effect.
}

function readPositiveDuration(value: number | undefined, fallback: number): number {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return fallback;
  }

  return value;
}

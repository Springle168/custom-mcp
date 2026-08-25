import type {
  ToolCallDiagnosticSink,
  ToolCallPipelineDiagnostic,
} from './tool-call-handler.js';
import type { ExternalRoutingProcessorDrainDiagnostic } from '../tools/external-routing/strategy-adapter.js';

export interface ApplicationDiagnosticLogger {
  info(message: string): void;
}

/**
 * Application-owned diagnostics bridge that can be injected during startup and
 * bound to the Logger before the listener admits requests.
 */
export class ApplicationDiagnostics {
  #logger: ApplicationDiagnosticLogger | undefined;
  #reportedFallbackFailure = false;

  readonly onToolCallDiagnostic: ToolCallDiagnosticSink = (diagnostic) => {
    this.#report(formatToolCallDiagnostic(diagnostic));
  };

  readonly onExternalProcessorDrain = (
    diagnostic: ExternalRoutingProcessorDrainDiagnostic,
  ): void => {
    this.#report(formatProcessorDrainDiagnostic(diagnostic));
  };

  bind(logger: ApplicationDiagnosticLogger): void {
    if (this.#logger !== undefined) {
      throw new Error('Application diagnostics logger is already bound.');
    }
    this.#logger = logger;
  }

  #report(message: string): void {
    try {
      if (this.#logger === undefined) {
        this.#reportFallbackFailure();
        return;
      }
      const loggerResult = this.#logger.info(message);
      // Although the injected type is void, implementations can still return
      // promises. Observe rejections without making processor cleanup wait.
      void Promise.resolve(loggerResult).catch(() => {
        this.#reportFallbackFailure();
      });
    } catch {
      this.#reportFallbackFailure();
    }
  }

  #reportFallbackFailure(): void {
    if (this.#reportedFallbackFailure) {
      return;
    }
    this.#reportedFallbackFailure = true;
    try {
      process.stderr.write('Application diagnostic sink unavailable.\n');
    } catch {
      // Diagnostics must never escape into invocation or cleanup control flow.
    }
  }
}

function formatToolCallDiagnostic(diagnostic: ToolCallPipelineDiagnostic): string {
  return `Tool-call diagnostic: kind=${diagnostic.kind} callId=${diagnostic.callId}`;
}

function formatProcessorDrainDiagnostic(
  diagnostic: ExternalRoutingProcessorDrainDiagnostic,
): string {
  return [
    'External Processor drain:',
    `route=${diagnostic.definitionId}`,
    `tool=${diagnostic.toolName}`,
    `role=${diagnostic.role}`,
    `processor=${diagnostic.processorName}`,
    `cleanupFailed=${diagnostic.cleanupFailed}`,
    `settledMs=${diagnostic.settledDurationMs}`,
    `drainMs=${diagnostic.drainDurationMs}`,
    `stdinBytes=${diagnostic.stdinBytes}`,
    `stdoutBytes=${diagnostic.stdoutBytes}`,
    `stderrBytes=${diagnostic.stderrByteCount}`,
    `stderrCapturedBytes=${diagnostic.stderrCapturedByteCount}`,
    `stderrTruncated=${diagnostic.stderrTruncated}`,
  ].join(' ');
}

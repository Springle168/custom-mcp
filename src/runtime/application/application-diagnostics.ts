import type {
  ToolCallDiagnosticSink,
  ToolCallPipelineDiagnostic,
} from '../invocation/tool-call-handler.js';
import type { ExternalRoutingProcessorDrainDiagnostic } from '../../tools/external-routing/strategy-adapter.js';
import type { McpConnectionDiagnostic } from '../../tools/external-routing/mcp-connection-manager.js';

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

  readonly onMcpConnectionDiagnostic = (
    diagnostic: McpConnectionDiagnostic,
  ): void => {
    this.#report(formatMcpConnectionDiagnostic(diagnostic));
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

function formatMcpConnectionDiagnostic(diagnostic: McpConnectionDiagnostic): string {
  if (diagnostic.outcome === 'connected') {
    return `Downstream MCP connected: server=${diagnostic.server} durationMs=${diagnostic.durationMs}`;
  }
  const label = diagnostic.phase === 'call'
    ? 'Downstream MCP call failed:'
    : diagnostic.phase === 'shutdown'
      ? 'Downstream MCP shutdown failed:'
      : 'Downstream MCP connection failed:';
  return [
    label,
    `server=${diagnostic.server}`,
    `phase=${diagnostic.phase}`,
    `classification=${diagnostic.classification ?? 'external_internal_failed'}`,
    `durationMs=${diagnostic.durationMs}`,
  ].join(' ');
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

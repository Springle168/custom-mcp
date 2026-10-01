import type { Server as HttpServer } from 'node:http';
import type { LoadRuntimeConfigOptions } from '../../config.js';
import { createWorkspaceToolService } from '../../tools/index.js';
import { androidGradleGateRegistry } from '../../utils/android-gradle-gate.js';
import { detachLingeringAndroidGradleExecutionsForShutdown } from '../../utils/android-gradle.js';
import { Logger } from '../../utils/logger.js';
import { createMcpHttpApp } from '../mcp/http-app.js';
import type { McpPostSession } from '../mcp/mcp-post-handler.js';
import { ApplicationDiagnostics } from './application-diagnostics.js';
import { ApplicationLifecycle } from './application-lifecycle.js';
import { createConfigStore } from './config-store.js';
import { formatApplicationStartupLines } from './startup-logging.js';
import { loadApplicationRuntime } from './startup-runtime.js';

export interface RunningApplication {
  readonly listener: HttpServer;
  close(signal?: 'SIGINT' | 'SIGTERM'): Promise<void>;
}

/** Composes application-owned resources and starts the listener without installing process handlers. */
export function startApplication(options: LoadRuntimeConfigOptions): RunningApplication {
  const diagnostics = new ApplicationDiagnostics();
  const runtime = loadApplicationRuntime({
    ...options,
    onExternalProcessorDrain: diagnostics.onExternalProcessorDrain,
    onMcpConnectionDiagnostic: diagnostics.onMcpConnectionDiagnostic,
  });
  const snapshot = runtime.snapshot;
  const configStore = createConfigStore(runtime);
  const toolService = createWorkspaceToolService(runtime.toolCatalog);
  const logger = new Logger(snapshot.logsDir, {
    workspaceId: snapshot.workspaceId,
  });
  diagnostics.bind(logger);

  const sessions = new Map<string, McpPostSession>();
  // Request callbacks run after synchronous listener/lifecycle assembly completes.
  let lifecycle: ApplicationLifecycle;
  const app = createMcpHttpApp({
    configStore,
    toolService,
    logger,
    sessions,
    isAcceptingNewSessions: () => lifecycle.isAcceptingNewSessions,
    closeSession: (sessionId) => lifecycle.closeSession(sessionId),
    onToolCallDiagnostic: diagnostics.onToolCallDiagnostic,
  });

  const listener = app.listen(snapshot.port, snapshot.host, () => {
    for (const line of formatApplicationStartupLines(
      snapshot,
      runtime.externalRoutingConfig,
      logger.logFile,
    )) {
      logger.info(line);
    }
    void runtime.warmUp().catch(() => {
      // Individual manager outcomes are reported through the diagnostic sink.
    });
  });
  lifecycle = new ApplicationLifecycle({
    listener,
    sessions,
    androidRuntime: {
      async close() {
        try {
          await androidGradleGateRegistry.close();
        } finally {
          detachLingeringAndroidGradleExecutionsForShutdown();
        }
      },
    },
    externalRuntime: runtime,
    logger,
  });

  return {
    listener,
    close(signal) {
      if (signal !== undefined) {
        try {
          logger.info(`Received ${signal}; starting graceful shutdown.`);
        } catch {
          // Shutdown must proceed even when the primary observability sink fails.
        }
      }
      return lifecycle.close();
    },
  };
}

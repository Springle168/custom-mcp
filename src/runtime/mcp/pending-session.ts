import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { InitializationTrackingTransport } from './initialization-tracking-transport.js';
import type { McpPostSession } from './mcp-post-handler.js';

/** Unpublished resources are owned before connect, and share one close operation. */
export interface McpPendingSession extends McpPostSession {
  readonly transport: InitializationTrackingTransport;
  readonly isClosed: boolean;
  readonly closed: Promise<void>;
  connect(): Promise<void>;
  close(): Promise<void>;
}

export function createPendingSession(
  server: Server,
  transport: InitializationTrackingTransport,
  onClosed: () => void,
): McpPendingSession {
  let isClosed = false;
  let closePromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  transport.onclose = () => {
    isClosed = true;
    transport.stopInitializationTracking();
    resolveClosed();
    onClosed();
  };

  return {
    server,
    transport,
    closed,
    get isClosed() {
      return isClosed;
    },
    async connect() {
      if (isClosed) {
        return;
      }
      await server.connect(transport);
    },
    close() {
      if (closePromise === undefined) {
        if (isClosed) {
          return Promise.resolve();
        }
        isClosed = true;
        resolveClosed();
        // SDK connect transfers ownership synchronously, before awaiting start.
        // Its public transport accessor also covers a partially failed connect.
        closePromise = Promise.resolve().then(async () => {
          transport.stopInitializationTracking();
          if (server.transport === transport) {
            await server.close();
          } else {
            await transport.close();
          }
        });
      }
      return closePromise;
    },
  };
}

import type { RuntimeConfigSnapshot } from '../config.js';
import type { WorkspaceToolService } from '../tools/index.js';
import type { ToolCallResult } from '../tools/types.js';
import type { ToolResultLogSummary } from './invocation/tool-call-log-context.js';

/** Session inputs are prepared before any server or transport is allocated. */
export interface McpSessionOptions {
  readonly toolService: WorkspaceToolService;
  readonly instructions?: string;
  readonly prepareToolResult?: PrepareToolResult;
}

export type SessionPreparation =
  | {
      readonly accepted: true;
      readonly options: McpSessionOptions;
      /** Observational only; invoked after publication without awaiting completion. */
      readonly onPublished?: (sessionId: string) => void | Promise<void>;
    }
  | {
      readonly accepted: false;
      /** Safe client-facing parameter diagnostic, not an arbitrary exception. */
      readonly message: string;
    };

/** Captured once at call start; adaptation follows core result validation. */
export interface PreparedToolResult {
  readonly adaptResult: (result: ToolCallResult) => ToolCallResult;
  /** Evaluated only inside the protected RESULT logging path. */
  readonly getLogSummary?: () => ToolResultLogSummary | undefined;
}

export type PrepareToolResult = (snapshot: RuntimeConfigSnapshot) => PreparedToolResult;

/**
 * Trusted synchronous internal stage hooks, not a general-purpose plugin API.
 * Core code retains protocol, execution, validation and resource ownership.
 */
export interface RuntimeExtensions {
  readonly defaultSessionOptions?: Pick<McpSessionOptions, 'prepareToolResult'>;
  readonly prepareSession?: (
    rawHeaders: readonly string[],
    defaults: McpSessionOptions,
  ) => SessionPreparation;
  /** Carries POST-local input across SDK dispatch without caching call policy. */
  readonly runWithPostContext?: <T>(rawHeaders: readonly string[], action: () => T) => T;
}

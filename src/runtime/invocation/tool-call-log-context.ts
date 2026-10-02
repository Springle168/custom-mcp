export interface ToolCallLogContext {
  readonly sessionId: string | undefined;
  readonly callId: string;
}

/** Trusted, preformatted observability text for the two logger output channels. */
export interface ToolResultLogSummary {
  readonly fileText: string;
  readonly consoleText: string;
}

export interface ToolCallResultLogContext extends ToolCallLogContext {
  readonly resultSummary?: ToolResultLogSummary;
}

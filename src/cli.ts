import { readWorkspaceIdToken } from './config/value-policy.js';

export interface CliOptions {
  readonly workspaceId?: string;
}

export class CliError extends Error {
  readonly suggestion?: string;

  constructor(message: string, suggestion?: string) {
    super(message);
    this.name = 'CliError';
    this.suggestion = suggestion;
  }
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let workspaceId: string | undefined;

  const args = argv[Symbol.iterator]();
  for (const arg of args) {
    if (arg === '--workspace') {
      const value = args.next();
      workspaceId = readWorkspaceIdValue(
        value.done ? undefined : value.value,
        workspaceId,
      );
      continue;
    }

    if (arg.startsWith('--workspace=')) {
      workspaceId = readWorkspaceIdValue(
        arg.slice('--workspace='.length),
        workspaceId,
      );
      continue;
    }

    throw new CliError(
      `Unknown argument: ${arg}`,
      'Supported arguments: --workspace <id> or --workspace=<id>.',
    );
  }

  return workspaceId === undefined ? {} : { workspaceId };
}

function readWorkspaceIdValue(
  value: string | undefined,
  currentWorkspaceId: string | undefined,
): string {
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(
      '--workspace requires a non-empty workspace id.',
      'Use --workspace <id> or --workspace=<id> to select a workspace from the global config.',
    );
  }

  const workspaceIdResult = readWorkspaceIdToken(value, { fieldPath: '--workspace' });
  if (!workspaceIdResult.ok) {
    throw new CliError(
      workspaceIdResult.error.message,
      'Use a workspace id from the global config. Workspace ids must be lowercase lexical tokens without leading or trailing whitespace.',
    );
  }

  if (currentWorkspaceId !== undefined) {
    throw new CliError(
      '--workspace can only be provided once.',
      'Remove the duplicate --workspace argument and restart the server.',
    );
  }

  return workspaceIdResult.value;
}

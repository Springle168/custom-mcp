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

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === '--workspace') {
      const value = argv[index + 1];
      workspaceId = readWorkspaceIdValue(value, workspaceId);
      index++;
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
  if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
    throw new CliError(
      '--workspace requires a non-empty workspace id.',
      'Use --workspace <id> or --workspace=<id> to select a workspace from the global config.',
    );
  }

  if (currentWorkspaceId !== undefined) {
    throw new CliError(
      '--workspace can only be provided once.',
      'Remove the duplicate --workspace argument and restart the server.',
    );
  }

  return value.trim();
}

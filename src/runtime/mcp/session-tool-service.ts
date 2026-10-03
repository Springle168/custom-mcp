import type { WorkspaceToolService } from '../../tools/index.js';
import { textErrorResult } from '../../tools/results.js';

/**
 * A session owns only an immutable exposure view. Validation, executors and
 * workspace resources remain owned by the shared service.
 */
export function createSessionToolService(
  workspaceService: WorkspaceToolService,
  requestedToolNames?: readonly string[],
): WorkspaceToolService {
  const requested = requestedToolNames === undefined ? undefined : new Set(requestedToolNames);
  const definitions = Object.freeze(
    workspaceService
      .getDefinitions()
      .filter((definition) => requested === undefined || requested.has(definition.name)),
  );
  // The closure is the only owner of this Set; no mutable collection escapes.
  const allowedNames = new Set(definitions.map((definition) => definition.name));

  return Object.freeze({
    getDefinitions: () => definitions,
    routeToolCall: async (name, args, context, invocationContext) => {
      if (!allowedNames.has(name)) {
        return textErrorResult(`Unknown tool: ${name}`);
      }
      return workspaceService.routeToolCall(name, args, context, invocationContext);
    },
  } satisfies WorkspaceToolService);
}

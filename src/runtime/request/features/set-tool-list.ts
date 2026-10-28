import { createSessionToolService } from '../../mcp/session-tool-service.js';
import type { InitializeContribution, InitializeFeatureParser } from '../feature-contracts.js';

const TOOL_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Capture only validated names; do not enumerate the shared service during parsing. */
export const parseSetToolList: InitializeFeatureParser = (payload, invalid) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return invalid('toolList');
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'toolList' || !Array.isArray(record.toolList)) {
    return invalid('toolList');
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of record.toolList) {
    if (typeof name !== 'string' || !TOOL_NAME_RE.test(name) || seen.has(name)) {
      return invalid('toolList');
    }
    seen.add(name);
    names.push(name);
  }
  const requestedNames = Object.freeze(names);

  return Object.freeze({
    prepareToolService: (base) => createSessionToolService(base, requestedNames),
  } satisfies InitializeContribution);
};

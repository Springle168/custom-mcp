import type { RuntimeConfigSnapshot } from '../../config.js';
import type { PreparedToolResult } from '../runtime-extensions.js';
import { getCurrentRequestHeaderView } from './request-context.js';
import {
  evaluateRequestHeaderPolicy,
  toRequestHeaderPolicyLogMetadata,
} from './request-header-policy.js';
import { formatRequestHeaderPolicyLogSummary } from './request-header-policy-logging.js';
import { adaptToolCallResultForRequestPolicy } from './tool-result-adapter.js';

/** Capture this POST's policy before CALL logging or execution can yield. */
export function prepareRequestHeaderToolResult(
  snapshot: RuntimeConfigSnapshot,
): PreparedToolResult {
  const policy = evaluateRequestHeaderPolicy(snapshot.rules, getCurrentRequestHeaderView());
  const metadata = toRequestHeaderPolicyLogMetadata(policy);

  return {
    adaptResult: (result) => adaptToolCallResultForRequestPolicy(result, policy.enabledFeatures),
    // Formatting belongs in the protected RESULT logging path. This supplier
    // retains only safe metadata, not the raw header view or configuration.
    getLogSummary: () => formatRequestHeaderPolicyLogSummary(metadata),
  };
}

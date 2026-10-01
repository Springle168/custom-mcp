import * as requestContextApi from '../../src/runtime/request/request-context.js';
import {
  getCurrentRequestHeaderView,
  runWithRequestHeaderContext,
} from '../../src/runtime/request/request-context.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request/request-header-view.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

function testContextIsReadableInsideCallback(): void {
  const view = createStrictRequestHeaderView(['X-Client', 'android-studio']);

  runWithRequestHeaderContext(view, () => {
    assertEqual(getCurrentRequestHeaderView(), view, 'Callback should read the same strict header view');
  });
}

function testContextIsUndefinedOutsideCallback(): void {
  assertEqual(getCurrentRequestHeaderView(), undefined, 'Request header context should be absent outside a request callback');
}

function testApiDoesNotExposeMutablePolicyState(): void {
  const api = requestContextApi as Record<string, unknown>;

  assert(api.setCurrentRequestHeaderView === undefined, 'Request context API should not export a strict header view setter');
  assert(api.setRequestHeaderPolicy === undefined, 'Request context API should not export a request policy setter');
  assert(api.policyCache === undefined, 'Request context API should not export a policy cache');
  assert(api.sessionPolicy === undefined, 'Request context API should not export session-level policy state');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing request header AsyncLocalStorage context',
    tests: [
      { name: 'context is readable inside callback', run: testContextIsReadableInsideCallback },
      { name: 'context is undefined outside callback', run: testContextIsUndefinedOutsideCallback },
      { name: 'API does not expose mutable policy state', run: testApiDoesNotExposeMutablePolicyState },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

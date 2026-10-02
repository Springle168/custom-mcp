import { AsyncLocalStorage } from 'node:async_hooks';
import type { StrictRequestHeaderView } from './request-header-view.js';

const requestHeaderContext = new AsyncLocalStorage<StrictRequestHeaderView>();

export function runWithRequestHeaderContext<T>(
  view: StrictRequestHeaderView,
  callback: () => T,
): T {
  // This AsyncLocalStorage only carries the strict header view for one HTTP request.
  // Request policy is still computed in the tools/call runtime path and is not cached here.
  return requestHeaderContext.run(view, callback);
}

export function getCurrentRequestHeaderView(): StrictRequestHeaderView | undefined {
  return requestHeaderContext.getStore();
}

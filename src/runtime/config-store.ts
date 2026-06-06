import type { RuntimeConfigSnapshot } from '../config.js';

export type ConfigStoreStatus =
  | { readonly state: 'ok' };

export interface ConfigStore {
  getSnapshot(): RuntimeConfigSnapshot;
  getStatus(): ConfigStoreStatus;
}

export function createConfigStore(
  initialSnapshot: RuntimeConfigSnapshot,
): ConfigStore {
  let currentSnapshot = initialSnapshot;
  const status: ConfigStoreStatus = Object.freeze({ state: 'ok' });

  return {
    getSnapshot(): RuntimeConfigSnapshot {
      return currentSnapshot;
    },
    getStatus(): ConfigStoreStatus {
      return status;
    },
  };
}

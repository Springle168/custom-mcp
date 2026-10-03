import type { LoadedRuntimeConfig, RuntimeConfigSnapshot } from '../../config.js';
import type { RuntimeConfigIdentity } from '../../config/workspace-selection.js';

export type ConfigStoreStatus = { readonly state: 'ok' };

export interface ConfigStore {
  getSnapshot(): RuntimeConfigSnapshot;
  getIdentity(): RuntimeConfigIdentity;
  getStatus(): ConfigStoreStatus;
}

export function createConfigStore(initialConfig: LoadedRuntimeConfig): ConfigStore {
  const currentSnapshot = initialConfig.snapshot;
  const identity = initialConfig.identity;
  const status: ConfigStoreStatus = Object.freeze({ state: 'ok' });

  return Object.freeze({
    getSnapshot(): RuntimeConfigSnapshot {
      return currentSnapshot;
    },
    getIdentity(): RuntimeConfigIdentity {
      return identity;
    },
    getStatus(): ConfigStoreStatus {
      return status;
    },
  });
}

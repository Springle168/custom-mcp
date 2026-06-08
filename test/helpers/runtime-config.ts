import * as path from 'node:path';
import {
  createRuntimeConfigSnapshot,
  type LoadedRuntimeConfig,
  type LineEnding,
  type RuntimeAndroidConfig,
  type RuntimeConfigIdentity,
  type RuntimeConfigSnapshot,
} from '../../src/config.js';
import { createConfigStore, type ConfigStore } from '../../src/runtime/config-store.js';
import {
  createToolRuntimeContext,
  type ToolRuntimeContext,
} from '../../src/runtime/tool-context.js';

export interface TestRuntimeConfigOptions {
  readonly rootDir: string;
  readonly otherRootDirs?: readonly string[];
  readonly lineEnding?: LineEnding;
  readonly port?: number;
  readonly android?: RuntimeAndroidConfig;
  readonly configFilePath?: string;
  readonly workspaceId?: string;
  readonly snapshotVersion?: number;
}

export function createTestRuntimeConfigSnapshot(
  options: TestRuntimeConfigOptions,
): RuntimeConfigSnapshot {
  return createRuntimeConfigSnapshot({
    configFilePath: options.configFilePath ?? path.join(options.rootDir, 'config.json'),
    workspaceId: options.workspaceId ?? 'test-workspace',
    rootDir: options.rootDir,
    otherRootDirs: options.otherRootDirs ?? [],
    port: options.port ?? 3100,
    lineEnding: options.lineEnding ?? 'auto',
    ...(options.android ? { android: options.android } : {}),
    snapshotVersion: options.snapshotVersion ?? 1,
  });
}

export function createTestRuntimeConfigIdentity(
  snapshot: RuntimeConfigSnapshot,
): RuntimeConfigIdentity {
  return Object.freeze({
    configFilePath: snapshot.configFilePath,
    workspaceId: snapshot.workspaceId,
    rootDir: snapshot.rootDir,
    port: snapshot.port,
    selectionMode: 'explicit',
  });
}

export function createTestLoadedRuntimeConfig(
  options: TestRuntimeConfigOptions,
): LoadedRuntimeConfig {
  const snapshot = createTestRuntimeConfigSnapshot(options);

  return Object.freeze({
    snapshot,
    identity: createTestRuntimeConfigIdentity(snapshot),
  });
}

export function createTestConfigStore(
  options: TestRuntimeConfigOptions,
): ConfigStore {
  return createConfigStore(createTestLoadedRuntimeConfig(options));
}

export function createTestToolRuntimeContext(
  options: TestRuntimeConfigOptions,
): ToolRuntimeContext {
  return createToolRuntimeContext(createTestRuntimeConfigSnapshot(options));
}

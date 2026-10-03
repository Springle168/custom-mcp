import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEmptyRuntimeRulesConfig,
  type LoadedRuntimeConfig,
  type LineEnding,
  type RuntimeAndroidConfig,
  type RuntimeConfigSnapshot,
  type RuntimeRulesConfig,
} from '../../src/config.js';
import { createRuntimeConfigSnapshot } from '../../src/config/runtime-snapshot.js';
import type { RuntimeConfigIdentity } from '../../src/config/workspace-selection.js';
import { createConfigStore, type ConfigStore } from '../../src/runtime/application/config-store.js';
import {
  createToolRuntimeContext,
  type ToolRuntimeContext,
} from '../../src/runtime/invocation/tool-context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_TEST_LOGS_DIR = path.join(__dirname, '..', 'logs', 'runtime-config-helper');

export interface TestRuntimeConfigOptions {
  readonly rootDir: string;
  readonly otherRootDirs?: readonly string[];
  readonly lineEnding?: LineEnding;
  readonly host?: string;
  readonly port?: number;
  readonly android?: RuntimeAndroidConfig;
  readonly logsDir?: string;
  readonly globalConfigFilePath?: string;
  readonly workspaceConfigFilePath?: string;
  readonly workspaceId?: string;
  readonly snapshotVersion?: number;
  readonly rules?: RuntimeRulesConfig;
}

export function createTestRuntimeConfigSnapshot(
  options: TestRuntimeConfigOptions,
): RuntimeConfigSnapshot {
  const logsDir = options.logsDir ?? getDefaultTestLogsDir();

  return createRuntimeConfigSnapshot({
    globalConfigFilePath: options.globalConfigFilePath ?? path.join(options.rootDir, 'config.json'),
    workspaceConfigFilePath:
      options.workspaceConfigFilePath ?? path.join(options.rootDir, 'workspace.json'),
    workspaceId: options.workspaceId ?? 'test-workspace',
    rootDir: options.rootDir,
    otherRootDirs: options.otherRootDirs ?? [],
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 3100,
    lineEnding: options.lineEnding ?? 'auto',
    logsDir,
    ...(options.android ? { android: options.android } : {}),
    rules: options.rules ?? createEmptyRuntimeRulesConfig(),
    snapshotVersion: options.snapshotVersion ?? 1,
  });
}

function getDefaultTestLogsDir(): string {
  mkdirSync(DEFAULT_TEST_LOGS_DIR, { recursive: true });
  return DEFAULT_TEST_LOGS_DIR;
}

export function createTestRuntimeConfigIdentity(
  snapshot: RuntimeConfigSnapshot,
): RuntimeConfigIdentity {
  return Object.freeze({
    globalConfigFilePath: snapshot.globalConfigFilePath,
    workspaceConfigFilePath: snapshot.workspaceConfigFilePath,
    workspaceId: snapshot.workspaceId,
    rootDir: snapshot.rootDir,
    host: snapshot.host,
    port: snapshot.port,
  });
}

export function createTestLoadedRuntimeConfig(
  options: TestRuntimeConfigOptions,
): LoadedRuntimeConfig {
  const snapshot = createTestRuntimeConfigSnapshot(options);

  return Object.freeze({
    snapshot,
    identity: createTestRuntimeConfigIdentity(snapshot),
    workspaceTools: Object.freeze({
      exposure: Object.freeze({ mode: 'all' as const }),
    }),
  });
}

export function createTestConfigStore(options: TestRuntimeConfigOptions): ConfigStore {
  return createConfigStore(createTestLoadedRuntimeConfig(options));
}

export function createTestToolRuntimeContext(
  options: TestRuntimeConfigOptions,
): ToolRuntimeContext {
  return createToolRuntimeContext(createTestRuntimeConfigSnapshot(options));
}

export type ConfigErrorCode =
  | 'home_dir_unavailable'
  | 'config_file_not_found'
  | 'config_file_read_failed'
  | 'config_json_invalid'
  | 'config_validation_failed';

export interface ConfigErrorOptions {
  readonly code: ConfigErrorCode;
  readonly message: string;
  readonly configFilePath?: string;
  readonly fieldPath?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly configFilePath?: string;
  readonly fieldPath?: string;
  readonly suggestion?: string;

  constructor(options: ConfigErrorOptions) {
    super(options.message);
    this.name = 'ConfigError';
    this.code = options.code;
    this.configFilePath = options.configFilePath;
    this.fieldPath = options.fieldPath;
    this.suggestion = options.suggestion;

    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }
}

export function isConfigError(error: unknown): error is ConfigError {
  return error instanceof ConfigError;
}

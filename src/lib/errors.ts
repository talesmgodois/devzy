/**
 * Process exit codes. Documented in README ("Exit codes").
 */
export const ExitCode = {
  Success: 0,
  /** Operational failure: every provider failed, a write failed, unexpected error. */
  Failure: 1,
  /** Invalid command, option, argument or filter combination. */
  Usage: 2,
  /** Output was produced but is incomplete: a provider failed or a health check did not pass. */
  Partial: 3,
  /** Configuration file missing (when explicitly requested), malformed, or invalid. */
  Config: 4,
  /** The user cancelled an interactive prompt (Ctrl+C / end of input). */
  Cancelled: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** An expected, user-facing error. Messages must not contain secrets. */
export class DevzyError extends Error {
  override name = "DevzyError";
  constructor(
    message: string,
    readonly exitCode: ExitCodeValue = ExitCode.Failure,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export class UsageError extends DevzyError {
  override name = "UsageError";
  constructor(message: string, hint?: string) {
    super(message, ExitCode.Usage, hint);
  }
}

export class ConfigError extends DevzyError {
  override name = "ConfigError";
  constructor(
    message: string,
    readonly details: string[] = [],
    hint?: string,
  ) {
    super(message, ExitCode.Config, hint);
  }
}

export class CancelledError extends DevzyError {
  override name = "CancelledError";
  constructor(message = "Cancelled. No changes were made.") {
    super(message, ExitCode.Cancelled);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

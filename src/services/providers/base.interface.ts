import type { ProviderCategory, ProviderMode } from "../../domain/activity.ts";

/**
 * Common provider metadata. Category-specific behaviour lives in GitProvider
 * and TaskProvider; optional capabilities (such as health checks) are separate
 * interfaces so that no provider has to implement methods it cannot support.
 *
 * Health is a *capability*, not a provider category: any Git or task provider
 * may implement {@link HealthCheckable}.
 */
export interface BaseProvider {
  /** Configured instance ID, e.g. `github-main`. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Provider type, e.g. `github`, `jira`. */
  readonly type: string;
  readonly category: ProviderCategory;
  readonly mode: ProviderMode;
}

export interface HealthCheckResult {
  ok: boolean;
  /** Diagnostic message. Must never contain credentials. */
  message: string;
}

export interface HealthCheckable {
  /** The signal is aborted when the health-check timeout elapses. */
  healthCheck(signal: AbortSignal): Promise<HealthCheckResult>;
}

export function isHealthCheckable<T extends object>(provider: T): provider is T & HealthCheckable {
  return typeof (provider as Partial<HealthCheckable>).healthCheck === "function";
}

import type { ReportSource } from "../domain/activity.ts";
import { errorMessage } from "../lib/errors.ts";
import type { ProviderRuntime } from "./aggregation.ts";
import type { ProviderEntry } from "./config/schema.ts";
import { isHealthCheckable } from "./providers/base.interface.ts";

/**
 * - `healthy` / `unhealthy`: the provider's check completed.
 * - `timeout`: no result within the timeout.
 * - `error`: the check threw, or the provider could not be initialised.
 * - `not_supported`: the provider does not implement health checks.
 * - `not_checked`: the provider is disabled.
 */
export type HealthStatus =
  | "healthy"
  | "unhealthy"
  | "timeout"
  | "error"
  | "not_supported"
  | "not_checked";

export const FAILING_HEALTH_STATUSES: readonly HealthStatus[] = ["unhealthy", "timeout", "error"];

export interface HealthRow {
  source: ReportSource;
  status: HealthStatus;
  message: string;
  durationMs: number | undefined;
}

class HealthTimeoutError extends Error {
  override name = "HealthTimeoutError";
}

/**
 * Runs health checks concurrently with a per-provider timeout. Each check is
 * isolated: an exception or timeout in one never affects the others.
 * Results are returned in configuration order.
 */
export async function runHealthChecks(
  runtime: ProviderRuntime,
  entries: readonly ProviderEntry[],
  timeoutMs: number,
): Promise<HealthRow[]> {
  return Promise.all(entries.map((entry) => checkOne(runtime, entry, timeoutMs)));
}

async function checkOne(
  runtime: ProviderRuntime,
  entry: ProviderEntry,
  timeoutMs: number,
): Promise<HealthRow> {
  const { registry, credentials, config, fetch } = runtime;
  const source = registry.source(entry);
  const row = (status: HealthStatus, message: string, durationMs?: number): HealthRow => ({
    source,
    status,
    message,
    durationMs,
  });

  if (!entry.enabled) return row("not_checked", "Provider is disabled.");
  const credential = credentials.get(entry.id) ?? {
    token: undefined,
    source: undefined,
    missingHint: "",
  };
  const instance = registry.instantiate(entry, credential, config.settings, fetch);
  if (!instance.ok) return row("error", instance.message);
  const provider = instance.provider;
  if (!isHealthCheckable(provider))
    return row("not_supported", "This adapter does not implement health checks.");

  const controller = new AbortController();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new HealthTimeoutError(`No response within ${timeoutMs} ms.`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    // Race so that a provider ignoring the abort signal still cannot block the command.
    const result = await Promise.race([provider.healthCheck(controller.signal), timeout]);
    const elapsed = Math.round(performance.now() - started);
    return row(result.ok ? "healthy" : "unhealthy", result.message, elapsed);
  } catch (error) {
    const elapsed = Math.round(performance.now() - started);
    if (
      error instanceof HealthTimeoutError ||
      controller.signal.reason instanceof HealthTimeoutError
    ) {
      return row("timeout", `No response within ${timeoutMs} ms.`, elapsed);
    }
    return row("error", errorMessage(error), elapsed);
  } finally {
    clearTimeout(timer);
  }
}

import { z } from "zod";
import type { HealthCheckResult } from "../base.interface.ts";

/**
 * Behaviour switches shared by every mock adapter, so demos and tests can
 * exercise failure paths deterministically.
 */
export const mockBehaviourShape = {
  /** Result of the mock health check. */
  health: z
    .enum(["healthy", "unhealthy", "timeout", "error"], {
      error: 'must be one of "healthy", "unhealthy", "timeout", "error"',
    })
    .default("healthy"),
  /** When true, report queries fail with a simulated error. */
  failReports: z.boolean({ error: "must be true or false" }).default(false),
};

export type MockHealthBehaviour = "healthy" | "unhealthy" | "timeout" | "error";

export class SimulatedProviderError extends Error {
  override name = "SimulatedProviderError";
}

export async function mockHealthCheck(
  behaviour: MockHealthBehaviour,
  signal: AbortSignal,
): Promise<HealthCheckResult> {
  switch (behaviour) {
    case "healthy":
      return { ok: true, message: "Mock provider: fixtures available (no network access)." };
    case "unhealthy":
      return { ok: false, message: "Mock provider configured to report unhealthy." };
    case "error":
      throw new SimulatedProviderError("Simulated connection failure (mock health: error).");
    case "timeout":
      // Never resolves on its own; settles only when the caller aborts.
      return new Promise<HealthCheckResult>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
  }
}

export function assertNotFailing(failReports: boolean, providerId: string): void {
  if (failReports) {
    throw new SimulatedProviderError(
      `Simulated failure for mock provider "${providerId}" (options.failReports is true).`,
    );
  }
}

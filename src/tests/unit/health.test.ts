import { describe, expect, test } from "bun:test";
import { FAILING_HEALTH_STATUSES, runHealthChecks } from "../../services/health.ts";
import { entry, makeRuntime } from "./fakes.ts";

describe("runHealthChecks", () => {
  test("isolates failures, applies timeouts and keeps configuration order", async () => {
    const entries = [
      entry("ok", "github"),
      entry("bad", "gitlab"),
      entry("throws", "jira"),
      entry("hangs", "linear"),
      entry("ignores-abort", "github"),
      entry("unsupported", "gitlab"),
      entry("off", "jira", { enabled: false }),
    ];
    const runtime = makeRuntime(entries, {
      ok: { health: async () => ({ ok: true, message: "fine" }) },
      bad: { health: async () => ({ ok: false, message: "degraded" }) },
      throws: {
        health: async () => {
          throw new Error("connection reset");
        },
      },
      hangs: {
        health: (signal) =>
          new Promise((_r, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          ),
      },
      "ignores-abort": { health: () => new Promise(() => undefined) },
      off: { health: async () => ({ ok: true, message: "should not run" }) },
    });

    const started = performance.now();
    const rows = await runHealthChecks(runtime, entries, 150);
    expect(performance.now() - started).toBeLessThan(1500);

    expect(rows.map((r) => [r.source.id, r.status, r.message])).toEqual([
      ["ok", "healthy", "fine"],
      ["bad", "unhealthy", "degraded"],
      ["throws", "error", "connection reset"],
      ["hangs", "timeout", "No response within 150 ms."],
      ["ignores-abort", "timeout", "No response within 150 ms."],
      ["unsupported", "not_supported", "This adapter does not implement health checks."],
      ["off", "not_checked", "Provider is disabled."],
    ]);
    expect(
      rows.filter((r) => FAILING_HEALTH_STATUSES.includes(r.status)).map((r) => r.source.id),
    ).toEqual(["bad", "throws", "hangs", "ignores-abort"]);
  });

  test("providers that cannot be instantiated report an error", async () => {
    const runtime = makeRuntime([entry("bb", "bitbucket")], {});
    const [row] = await runHealthChecks(runtime, runtime.config.providers, 100);
    expect(row?.status).toBe("error");
    expect(row?.message).toContain("not implemented");
  });
});

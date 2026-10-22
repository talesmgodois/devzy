import { z } from "zod";
import {
  emptyFilters,
  type ReportFilters,
  type ReportKind,
  type ReportQuery,
} from "../../domain/filters.ts";
import type { GitCommitStats } from "../../domain/git.ts";
import type { TeamMember } from "../../domain/identity.ts";
import { periodFromDates } from "../../domain/period.ts";
import type { TaskStatsResult } from "../../domain/tasks.ts";
import type { ProviderRuntime } from "../../services/aggregation.ts";
import { DEFAULT_SETTINGS, type ProviderEntry } from "../../services/config/schema.ts";
import type {
  AdapterContext,
  AdapterDefinition,
  Provider,
} from "../../services/providers/adapter.ts";
import type { HealthCheckResult } from "../../services/providers/base.interface.ts";
import { type AdapterTable, ProviderRegistry } from "../../services/providers/registry.ts";

export interface FakeBehaviour {
  git?: GitCommitStats[] | Error;
  tasks?: TaskStatsResult | Error;
  health?: (signal: AbortSignal) => Promise<HealthCheckResult>;
}

/** Registry whose adapters return scripted data keyed by provider instance ID. */
export function fakeRegistry(behaviours: Record<string, FakeBehaviour>): ProviderRegistry {
  const adapter = (mode: "mock" | "live"): AdapterDefinition => ({
    mode,
    optionsSchema: z.record(z.string(), z.unknown()),
    setupFields: [],
    create(ctx: AdapterContext): Provider {
      const b = behaviours[ctx.id] ?? {};
      const base = { id: ctx.id, name: ctx.name, type: ctx.type, mode };
      const health = b.health ? { healthCheck: b.health } : {};
      if (ctx.type === "github" || ctx.type === "gitlab") {
        return {
          ...base,
          ...health,
          category: "git",
          async getCommitStats() {
            if (b.git instanceof Error) throw b.git;
            return structuredClone(b.git ?? []);
          },
        };
      }
      return {
        ...base,
        ...health,
        category: "tasks",
        async getUserTaskStats() {
          if (b.tasks instanceof Error) throw b.tasks;
          return structuredClone(b.tasks ?? { users: [], unmappedStatuses: [] });
        },
      };
    },
  });
  const both = { mock: adapter("mock"), live: adapter("live") };
  const table: AdapterTable = { github: both, gitlab: both, jira: both, linear: both };
  return new ProviderRegistry(table);
}

export function entry(
  id: string,
  type: ProviderEntry["type"],
  extra: Partial<ProviderEntry> = {},
): ProviderEntry {
  return { id, type, name: id, enabled: true, mode: "mock", options: {}, ...extra };
}

export function makeRuntime(
  entries: ProviderEntry[],
  behaviours: Record<string, FakeBehaviour>,
  identities: TeamMember[] = [],
): ProviderRuntime {
  return {
    registry: fakeRegistry(behaviours),
    config: { version: 1, settings: { ...DEFAULT_SETTINGS }, providers: entries, identities },
    credentials: new Map(),
    fetch: () => Promise.reject(new Error("network disabled in tests")),
  };
}

export function query(kind: ReportKind, filters: Partial<ReportFilters> = {}): ReportQuery {
  return {
    kind,
    period: periodFromDates(
      { since: "2026-01-01", to: "2026-01-31" },
      30,
      new Date("2026-02-15T00:00:00Z"),
    ),
    filters: { ...emptyFilters(), ...filters },
  };
}

export function commit(
  repository: string,
  name: string,
  commits: number,
  extra: Partial<GitCommitStats["author"]> = {},
): GitCommitStats {
  return { repository, commits, author: { displayName: name, ...extra } };
}

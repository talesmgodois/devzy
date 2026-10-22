import type { ProviderCategory } from "../domain/activity.ts";
import { FilterError, type ReportFilters, type ReportKind } from "../domain/filters.ts";
import { emptyTaskCounts, TASK_STATUSES, type TaskCounts } from "../domain/tasks.ts";
import type { ProviderEntry } from "./config/schema.ts";
import type { ResolvedIdentity } from "./identity-resolver.ts";
import { PROVIDER_TYPES } from "./providers/catalog.ts";

export const REPORT_CATEGORIES: Record<ReportKind, readonly ProviderCategory[]> = {
  git: ["git"],
  tasks: ["tasks"],
  all: ["git", "tasks"],
};

function matchesProviderValue(entry: ProviderEntry, value: string): boolean {
  return entry.id === value || entry.type === value;
}

/**
 * Selects the enabled providers a report should query. Every `--provider`
 * value must match at least one enabled provider of a category the report
 * covers; otherwise the user gets an actionable error instead of an empty report.
 */
export function selectProviders(
  entries: readonly ProviderEntry[],
  filters: ReportFilters,
  kind: ReportKind,
): ProviderEntry[] {
  const categories = REPORT_CATEGORIES[kind];
  const inCategory = (e: ProviderEntry) => categories.includes(PROVIDER_TYPES[e.type].category);

  for (const value of filters.providers) {
    const matching = entries.filter((e) => matchesProviderValue(e, value));
    if (matching.length === 0) {
      const configured = entries.map((e) => e.id).join(", ") || "none";
      throw new FilterError(
        `--provider ${value} does not match any configured provider ID or type (configured: ${configured}).`,
      );
    }
    const relevant = matching.filter(inCategory);
    if (relevant.length === 0) {
      const other = PROVIDER_TYPES[(matching[0] as ProviderEntry).type].category;
      throw new FilterError(
        `--provider ${value} refers to ${other} providers, but this report covers only ${categories.join(" and ")} providers.`,
      );
    }
    if (!relevant.some((e) => e.enabled)) {
      throw new FilterError(
        `--provider ${value} matches only disabled providers (${relevant.map((e) => e.id).join(", ")}).`,
      );
    }
  }

  return entries.filter(
    (e) =>
      e.enabled &&
      inCategory(e) &&
      (filters.providers.length === 0 || filters.providers.some((v) => matchesProviderValue(e, v))),
  );
}

export function matchesRepository(repository: string, filters: ReportFilters): boolean {
  return (
    filters.repositories.length === 0 || filters.repositories.includes(repository.toLowerCase())
  );
}

export type EmailFilterOutcome = "match" | "no-match" | "unknown";

/**
 * Evaluates the email filter against a resolved contributor:
 * `unknown` means the row has no email and no identity mapping that provides
 * one, so the filter cannot be evaluated. Such rows are excluded and counted
 * so the report can state the limitation.
 */
export function emailFilterOutcome(
  identity: ResolvedIdentity,
  filters: ReportFilters,
): EmailFilterOutcome {
  if (filters.emails.length === 0) return "match";
  if (identity.emails.size === 0) return "unknown";
  return filters.emails.some((e) => identity.emails.has(e)) ? "match" : "no-match";
}

/** Zeroes buckets not selected by `--status`. Returns undefined if nothing remains. */
export function applyStatusFilter(
  counts: TaskCounts,
  filters: ReportFilters,
): TaskCounts | undefined {
  if (filters.statuses.length === 0) return { ...counts };
  const out = emptyTaskCounts();
  let total = 0;
  for (const status of TASK_STATUSES) {
    if (filters.statuses.includes(status)) {
      out[status] = counts[status];
      total += counts[status];
    }
  }
  return total > 0 ? out : undefined;
}

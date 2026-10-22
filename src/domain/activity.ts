import type { ReportKind, ReportQuery } from "./filters.ts";
import type { IdentityMatch } from "./identity.ts";
import type { TaskCounts } from "./tasks.ts";

export type ProviderCategory = "git" | "tasks";
export type ProviderMode = "mock" | "live";

/** A provider instance that contributed (or tried to contribute) to a report. */
export interface ReportSource {
  id: string;
  name: string;
  type: string;
  category: ProviderCategory;
  mode: ProviderMode;
}

/** A provider that failed. The message must already be free of secrets. */
export interface ProviderFailure {
  source: ReportSource;
  message: string;
}

export interface ContributorSummary {
  /** Stable aggregation key (see services/identity-resolver.ts). */
  key: string;
  displayName: string;
  identity: IdentityMatch;
  /** Canonical team-member ID when `identity` is `mapped`. */
  memberId?: string | undefined;
  /** Provider instance IDs that reported this contributor, sorted. */
  providers: string[];
}

export interface GitReportRow extends ContributorSummary {
  commits: number;
  /** Distinct `providerId:repository` pairs, sorted. */
  repositories: string[];
}

export interface TaskReportRow extends ContributorSummary {
  counts: TaskCounts;
}

export interface CombinedReportRow extends ContributorSummary {
  /** Undefined when no Git provider reported this contributor. */
  commits: number | undefined;
  /** Undefined when no task provider reported this contributor. */
  tasks: TaskCounts | undefined;
}

export interface ReportRowByKind {
  git: GitReportRow;
  tasks: TaskReportRow;
  all: CombinedReportRow;
}

export interface ActivityReport<K extends ReportKind = ReportKind> {
  kind: K;
  query: ReportQuery;
  sortKey: SortKey;
  /** Providers selected for the report, in configuration order. */
  sources: ReportSource[];
  failures: ProviderFailure[];
  rows: ReportRowByKind[K][];
  /** Context the reader needs to interpret the numbers (unmapped statuses, identity issues). */
  notes: string[];
}

export const SORT_KEYS = ["commits", "completed", "in_progress", "in_review", "name"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_KEYS_BY_REPORT: Record<ReportKind, readonly SortKey[]> = {
  git: ["commits", "name"],
  tasks: ["completed", "in_progress", "in_review", "name"],
  all: ["commits", "completed", "in_progress", "in_review", "name"],
};

export const DEFAULT_SORT_KEY: Record<ReportKind, SortKey> = {
  git: "commits",
  tasks: "completed",
  all: "commits",
};

export function isPartial(report: ActivityReport): boolean {
  return report.failures.length > 0;
}

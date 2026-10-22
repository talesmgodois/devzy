import type {
  CombinedReportRow,
  ContributorSummary,
  GitReportRow,
  SortKey,
  TaskReportRow,
} from "../domain/activity.ts";
import type { TaskStatus } from "../domain/tasks.ts";

/**
 * Ranking rules (documented in README):
 * 1. The selected sort metric, descending (`name` sorts ascending).
 * 2. The report's remaining metrics, descending, in this order:
 *    commits, completed, in_review, in_progress.
 * 3. Display name, ascending, case-insensitive.
 * 4. Aggregation key, ascending (guarantees a total, stable order).
 * Missing values (e.g. no Git records in `pm all`) count as 0.
 */
const METRIC_ORDER: readonly Exclude<SortKey, "name">[] = [
  "commits",
  "completed",
  "in_review",
  "in_progress",
];

type Metric = Exclude<SortKey, "name">;
type MetricReader<R> = Partial<Record<Metric, (row: R) => number>>;

const GIT_METRICS: MetricReader<GitReportRow> = { commits: (r) => r.commits };

const taskMetric = (status: TaskStatus) => (r: TaskReportRow) => r.counts[status];
const TASK_METRICS: MetricReader<TaskReportRow> = {
  completed: taskMetric("completed"),
  in_review: taskMetric("in_review"),
  in_progress: taskMetric("in_progress"),
};

const combinedTask = (status: TaskStatus) => (r: CombinedReportRow) => r.tasks?.[status] ?? 0;
const COMBINED_METRICS: MetricReader<CombinedReportRow> = {
  commits: (r) => r.commits ?? 0,
  completed: combinedTask("completed"),
  in_review: combinedTask("in_review"),
  in_progress: combinedTask("in_progress"),
};

export function compareNames(a: ContributorSummary, b: ContributorSummary): number {
  const byName = a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function sortRows<R extends ContributorSummary>(
  rows: R[],
  sortKey: SortKey,
  metrics: MetricReader<R>,
): R[] {
  const order: Metric[] = [];
  if (sortKey !== "name") order.push(sortKey);
  for (const m of METRIC_ORDER) if (!order.includes(m) && sortKey !== "name") order.push(m);
  const readers = order
    .map((m) => metrics[m])
    .filter((r): r is (row: R) => number => r !== undefined);
  return [...rows].sort((a, b) => {
    for (const read of readers) {
      const diff = read(b) - read(a);
      if (diff !== 0) return diff;
    }
    return compareNames(a, b);
  });
}

export const rankGitRows = (rows: GitReportRow[], key: SortKey) => sortRows(rows, key, GIT_METRICS);
export const rankTaskRows = (rows: TaskReportRow[], key: SortKey) =>
  sortRows(rows, key, TASK_METRICS);
export const rankCombinedRows = (rows: CombinedReportRow[], key: SortKey) =>
  sortRows(rows, key, COMBINED_METRICS);

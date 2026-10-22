import type { ReportingPeriod } from "../../../domain/period.ts";
import type { TaskStatsResult } from "../../../domain/tasks.ts";
import type { BaseProvider } from "../base.interface.ts";

export interface TaskStatsQuery {
  period: ReportingPeriod;
  signal?: AbortSignal | undefined;
}

export interface TaskProvider extends BaseProvider {
  readonly category: "tasks";
  /**
   * Returns normalized per-assignee counts for tasks whose status last changed
   * within the period, plus any vendor statuses that could not be normalized.
   */
  getUserTaskStats(query: TaskStatsQuery): Promise<TaskStatsResult>;
}

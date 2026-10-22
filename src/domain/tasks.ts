import type { ContributorRef } from "./identity.ts";

/** Normalized task status buckets. */
export const TASK_STATUSES = ["completed", "in_progress", "in_review"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  completed: "Completed",
  in_progress: "In progress",
  in_review: "In review / testing",
};

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export type TaskCounts = Record<TaskStatus, number>;

export function emptyTaskCounts(): TaskCounts {
  return { completed: 0, in_progress: 0, in_review: 0 };
}

/** Task activity for one contributor from one provider during a period. */
export interface UserTaskStats {
  assignee: ContributorRef;
  counts: TaskCounts;
}

/** A vendor status that has no normalized bucket. Such tasks are excluded from counts. */
export interface UnmappedStatusCount {
  status: string;
  count: number;
}

/** Tasks left out for a reason other than their status (e.g. no assignee). */
export interface ExcludedTaskCount {
  /** Completes "excluded N task(s) …", e.g. "without an assignee". */
  reason: string;
  count: number;
}

export interface TaskStatsResult {
  users: UserTaskStats[];
  unmappedStatuses: UnmappedStatusCount[];
  /** Optional: adapters that drop tasks before normalization report them here. */
  excluded?: ExcludedTaskCount[];
}

/**
 * Vendor status → bucket table. Keys are compared case-insensitively after
 * trimming. A status absent from the table is *unmapped*: it is reported and
 * excluded, never silently counted as completed (or anything else).
 */
export type StatusMapping = Readonly<Record<string, TaskStatus>>;

/**
 * Merges status tables case-insensitively; later tables win. Keys are stored
 * lowercased, so an override such as `{ "done": … }` replaces a default `Done`.
 */
export function mergeStatusMaps(...tables: (StatusMapping | undefined)[]): StatusMapping {
  const merged: Record<string, TaskStatus> = {};
  for (const table of tables) {
    for (const [vendor, bucket] of Object.entries(table ?? {}))
      merged[vendor.trim().toLowerCase()] = bucket;
  }
  return merged;
}

export function normalizeTaskStatus(raw: string, mapping: StatusMapping): TaskStatus | undefined {
  const key = raw.trim().toLowerCase();
  for (const [vendor, bucket] of Object.entries(mapping)) {
    if (vendor.trim().toLowerCase() === key) return bucket;
  }
  return undefined;
}

/** A single vendor task observation, used by adapters before aggregation. */
export interface VendorTaskEvent {
  assignee: ContributorRef;
  /** Key that uniquely identifies the assignee within the provider. */
  assigneeKey: string;
  status: string;
}

/**
 * Folds vendor task events into per-assignee counts using a status mapping.
 * Shared by adapters so normalization rules are identical everywhere.
 */
export function summarizeTaskEvents(
  events: Iterable<VendorTaskEvent>,
  mapping: StatusMapping,
): TaskStatsResult {
  const users = new Map<string, UserTaskStats>();
  const unmapped = new Map<string, number>();
  for (const event of events) {
    const bucket = normalizeTaskStatus(event.status, mapping);
    if (!bucket) {
      unmapped.set(event.status, (unmapped.get(event.status) ?? 0) + 1);
      continue;
    }
    let entry = users.get(event.assigneeKey);
    if (!entry) {
      entry = { assignee: event.assignee, counts: emptyTaskCounts() };
      users.set(event.assigneeKey, entry);
    }
    entry.counts[bucket] += 1;
  }
  return {
    users: [...users.values()],
    unmappedStatuses: [...unmapped.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => (a.status < b.status ? -1 : a.status > b.status ? 1 : 0)),
  };
}

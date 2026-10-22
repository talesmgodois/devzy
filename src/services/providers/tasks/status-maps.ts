import type { StatusMapping } from "../../../domain/tasks.ts";

/**
 * Vendor status → normalized bucket tables. Matching is case-insensitive.
 * Statuses not listed (e.g. "Blocked", "Backlog", "Canceled") are unmapped:
 * they are excluded from counts and reported in the report notes.
 */
export const JIRA_STATUS_MAP: StatusMapping = {
  Done: "completed",
  Closed: "completed",
  Resolved: "completed",
  "In Progress": "in_progress",
  "In Development": "in_progress",
  "In Review": "in_review",
  "Code Review": "in_review",
  QA: "in_review",
  Testing: "in_review",
};

export const LINEAR_STATUS_MAP: StatusMapping = {
  Done: "completed",
  "In Progress": "in_progress",
  "In Review": "in_review",
};

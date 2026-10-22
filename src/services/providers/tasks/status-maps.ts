import { z } from "zod";
import { type StatusMapping, TASK_STATUSES } from "../../../domain/tasks.ts";

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

/**
 * OpenProject's default workflow statuses. "Developed", "In testing" and
 * "Tested" wait for review/QA; "Rejected" and "On hold" are unmapped.
 */
export const OPENPROJECT_STATUS_MAP: StatusMapping = {
  Closed: "completed",
  Resolved: "completed",
  "In progress": "in_progress",
  Developed: "in_review",
  "In testing": "in_review",
  Tested: "in_review",
  "In review": "in_review",
};

/** Optional per-instance overrides, merged over the defaults (case-insensitive). */
export const statusMapSchema = z.record(
  z.string().trim().min(1, { error: "status names must not be empty" }),
  z.enum(TASK_STATUSES, { error: `must be one of: ${TASK_STATUSES.join(", ")}` }),
);

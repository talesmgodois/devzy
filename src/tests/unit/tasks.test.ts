import { describe, expect, test } from "bun:test";
import { normalizeTaskStatus, summarizeTaskEvents } from "../../domain/tasks.ts";
import { JIRA_STATUS_MAP, LINEAR_STATUS_MAP } from "../../services/providers/tasks/status-maps.ts";

describe("task status normalization", () => {
  test.each([
    ["Done", "completed"],
    ["closed", "completed"],
    ["  In Progress ", "in_progress"],
    ["QA", "in_review"],
    ["code review", "in_review"],
    ["In Code Review", "in_review"],
    ["IN CODE REVIEW", "in_review"],
    ["Ready for Test", "in_review"],
    ["In Test", "in_review"],
  ])("jira %p -> %p", (raw, bucket) => {
    expect(normalizeTaskStatus(raw, JIRA_STATUS_MAP)).toBe(bucket as never);
  });

  test.each(["Blocked", "Backlog", "Won't Do", "Done-ish", ""])(
    "unknown jira status %p is unmapped",
    (raw) => {
      expect(normalizeTaskStatus(raw, JIRA_STATUS_MAP)).toBeUndefined();
    },
  );

  test("linear Canceled is not treated as completed", () => {
    expect(normalizeTaskStatus("Canceled", LINEAR_STATUS_MAP)).toBeUndefined();
    expect(normalizeTaskStatus("Done", LINEAR_STATUS_MAP)).toBe("completed");
  });

  test("summarizeTaskEvents counts per assignee and reports unmapped statuses", () => {
    const ana = { displayName: "Ana", email: "ana@example.com" };
    const result = summarizeTaskEvents(
      [
        { assignee: ana, assigneeKey: "ana", status: "Done" },
        { assignee: ana, assigneeKey: "ana", status: "In Review" },
        { assignee: ana, assigneeKey: "ana", status: "Blocked" },
        { assignee: ana, assigneeKey: "ana", status: "Blocked" },
        { assignee: ana, assigneeKey: "ana", status: "Icebox" },
      ],
      JIRA_STATUS_MAP,
    );
    expect(result.users).toHaveLength(1);
    expect(result.users[0]?.counts).toEqual({ completed: 1, in_progress: 0, in_review: 1 });
    expect(result.unmappedStatuses).toEqual([
      { status: "Blocked", count: 2 },
      { status: "Icebox", count: 1 },
    ]);
  });
});

describe("mergeStatusMaps", () => {
  test("later tables win case-insensitively", async () => {
    const { mergeStatusMaps } = await import("../../domain/tasks.ts");
    const merged = mergeStatusMaps(JIRA_STATUS_MAP, { done: "in_review", Blocked: "in_progress" });
    expect(normalizeTaskStatus("Done", merged)).toBe("in_review");
    expect(normalizeTaskStatus("BLOCKED", merged)).toBe("in_progress");
    expect(normalizeTaskStatus("Closed", merged)).toBe("completed");
  });
});

describe("taskTotal", () => {
  test("sums all buckets", async () => {
    const { taskTotal } = await import("../../domain/tasks.ts");
    expect(taskTotal({ completed: 3, in_progress: 2, in_review: 4 })).toBe(9);
    expect(taskTotal({ completed: 0, in_progress: 0, in_review: 0 })).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import type { CombinedReportRow, GitReportRow, TaskReportRow } from "../../domain/activity.ts";
import { emptyFilters, FilterError } from "../../domain/filters.ts";
import { selectProviders } from "../../services/filtering.ts";
import { rankCombinedRows, rankGitRows, rankTaskRows } from "../../services/ranking.ts";
import { entry } from "./fakes.ts";

describe("selectProviders", () => {
  const entries = [
    entry("gh-a", "github"),
    entry("gh-b", "github"),
    entry("gl", "gitlab", { enabled: false }),
    entry("jira", "jira"),
  ];

  test("no provider filter selects enabled providers of the report's categories", () => {
    expect(selectProviders(entries, emptyFilters(), "git").map((e) => e.id)).toEqual([
      "gh-a",
      "gh-b",
    ]);
    expect(selectProviders(entries, emptyFilters(), "all").map((e) => e.id)).toEqual([
      "gh-a",
      "gh-b",
      "jira",
    ]);
  });

  test("matches by type or instance ID; repeated values are OR", () => {
    const byType = selectProviders(entries, { ...emptyFilters(), providers: ["github"] }, "git");
    expect(byType.map((e) => e.id)).toEqual(["gh-a", "gh-b"]);
    const byIds = selectProviders(
      entries,
      { ...emptyFilters(), providers: ["gh-b", "jira"] },
      "all",
    );
    expect(byIds.map((e) => e.id)).toEqual(["gh-b", "jira"]);
  });

  test("rejects unknown, wrong-category and disabled-only providers", () => {
    expect(() =>
      selectProviders(entries, { ...emptyFilters(), providers: ["nope"] }, "git"),
    ).toThrow(/does not match/);
    expect(() =>
      selectProviders(entries, { ...emptyFilters(), providers: ["jira"] }, "git"),
    ).toThrow(/refers to tasks providers/);
    expect(() => selectProviders(entries, { ...emptyFilters(), providers: ["gl"] }, "git")).toThrow(
      FilterError,
    );
  });
});

const summary = (key: string, displayName: string) => ({
  key,
  displayName,
  identity: "email" as const,
  memberId: undefined,
  providers: [],
});

describe("ranking", () => {
  test("git: commits desc, then name, then key", () => {
    const rows: GitReportRow[] = [
      { ...summary("k3", "bob"), commits: 5, repositories: [] },
      { ...summary("k2", "Alice"), commits: 5, repositories: [] },
      { ...summary("k1", "alice"), commits: 5, repositories: [] },
      { ...summary("k4", "Zed"), commits: 9, repositories: [] },
    ];
    expect(rankGitRows(rows, "commits").map((r) => r.key)).toEqual(["k4", "k1", "k2", "k3"]);
    expect(rankGitRows(rows, "name").map((r) => r.key)).toEqual(["k1", "k2", "k3", "k4"]);
  });

  test("tasks: primary metric, then completed, in_review, in_progress", () => {
    const row = (
      key: string,
      completed: number,
      in_progress: number,
      in_review: number,
    ): TaskReportRow => ({
      ...summary(key, "Same"),
      counts: { completed, in_progress, in_review },
    });
    const rows = [row("a", 1, 5, 0), row("b", 1, 0, 2), row("c", 3, 0, 0)];
    expect(rankTaskRows(rows, "completed").map((r) => r.key)).toEqual(["c", "b", "a"]);
    expect(rankTaskRows(rows, "in_progress").map((r) => r.key)).toEqual(["a", "c", "b"]);
  });

  test("combined: missing values count as zero; ordering is stable for ties", () => {
    const row = (
      key: string,
      commits: number | undefined,
      completed?: number,
    ): CombinedReportRow => ({
      ...summary(key, key),
      commits,
      tasks: completed === undefined ? undefined : { completed, in_progress: 0, in_review: 0 },
    });
    const rows = [row("d", undefined, 4), row("c", 2), row("b", 2, 1), row("a", 0)];
    expect(rankCombinedRows(rows, "commits").map((r) => r.key)).toEqual(["b", "c", "d", "a"]);
    expect(rankCombinedRows(rows, "completed").map((r) => r.key)).toEqual(["d", "b", "c", "a"]);
  });
});

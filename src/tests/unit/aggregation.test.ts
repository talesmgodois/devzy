import { describe, expect, test } from "bun:test";
import type { GitReportRow } from "../../domain/activity.ts";
import { UsageError } from "../../lib/errors.ts";
import { ActivityService } from "../../services/aggregation.ts";
import { commit, entry, makeRuntime, query } from "./fakes.ts";

const ana = { email: "ana@example.com", providerUserId: "1" };
const ben = { email: "ben@example.com", providerUserId: "2" };

describe("git aggregation", () => {
  test("sums rows per contributor across repositories and providers without double counting", async () => {
    const service = new ActivityService(
      makeRuntime([entry("gh", "github"), entry("gl", "gitlab")], {
        gh: {
          git: [
            commit("acme/api", "Ana", 3, ana),
            commit("acme/web", "Ana", 2, ana),
            commit("acme/api", "Ben", 4, ben),
          ],
        },
        gl: { git: [commit("acme/api", "Ana S.", 1, { email: "ANA@example.com" })] },
      }),
    );
    const report = await service.gitReport(query("git"), { sortKey: "commits" });
    const anaRow = report.rows.find((r) => r.key === "email:ana@example.com") as GitReportRow;
    expect(anaRow.commits).toBe(6);
    expect(anaRow.repositories).toEqual(["gh:acme/api", "gh:acme/web", "gl:acme/api"]);
    expect(anaRow.providers).toEqual(["gh", "gl"]);
    expect(report.rows.map((r) => r.commits)).toEqual([6, 4]);
    expect(report.failures).toEqual([]);
  });

  test("does not merge contributors that share only a display name", async () => {
    const service = new ActivityService(
      makeRuntime([entry("gh", "github")], {
        gh: {
          git: [
            commit("acme/api", "Sam Lee", 2, { email: "sam@example.com" }),
            commit("acme/api", "Sam Lee", 2, { email: "sam.lee@example.org" }),
          ],
        },
      }),
    );
    const report = await service.gitReport(query("git"), { sortKey: "commits" });
    expect(report.rows).toHaveLength(2);
  });

  test("repository filter is applied locally even if the provider ignores it", async () => {
    const service = new ActivityService(
      makeRuntime([entry("gh", "github")], {
        gh: { git: [commit("acme/api", "Ana", 3, ana), commit("acme/web", "Ana", 5, ana)] },
      }),
    );
    const report = await service.gitReport(query("git", { repositories: ["acme/web"] }), {
      sortKey: "commits",
    });
    expect(report.rows.map((r) => [r.commits, r.repositories])).toEqual([[5, ["gh:acme/web"]]]);
  });

  test("email filter: exact normalized match only (no substring)", async () => {
    const service = new ActivityService(
      makeRuntime([entry("gh", "github")], {
        gh: {
          git: [
            commit("r/a", "Ana", 3, { email: "ana@example.com" }),
            commit("r/a", "Hannah", 3, { email: "hannah@example.com" }),
            commit("r/a", "Ana2", 1, { email: "ana@example.co" }),
          ],
        },
      }),
    );
    const report = await service.gitReport(query("git", { emails: ["ana@example.com"] }), {
      sortKey: "commits",
    });
    expect(report.rows.map((r) => r.displayName)).toEqual(["Ana"]);
  });

  test("email filter matches through an identity alias", async () => {
    const runtime = makeRuntime(
      [entry("gh", "github")],
      { gh: { git: [commit("r/a", "Ana", 3, { email: "ana@personal.example" })] } },
      [
        {
          id: "ana",
          name: "Ana Souza",
          emails: ["ana@example.com", "ana@personal.example"],
          accounts: [],
        },
      ],
    );
    const report = await new ActivityService(runtime).gitReport(
      query("git", { emails: ["ana@example.com"] }),
      {
        sortKey: "commits",
      },
    );
    expect(report.rows.map((r) => [r.displayName, r.identity])).toEqual([["Ana Souza", "mapped"]]);
  });

  test("provider failure is reported, not converted to zero activity", async () => {
    const service = new ActivityService(
      makeRuntime([entry("gh", "github"), entry("gl", "gitlab")], {
        gh: { git: [commit("r/a", "Ana", 3, ana)] },
        gl: { git: new Error("boom") },
      }),
    );
    const report = await service.gitReport(query("git"), { sortKey: "commits" });
    expect(report.failures.map((f) => [f.source.id, f.message])).toEqual([["gl", "boom"]]);
    expect(report.sources.map((s) => s.id)).toEqual(["gh", "gl"]);
    expect(report.rows.every((r) => !r.providers.includes("gl"))).toBe(true);
  });

  test("ambiguous identities are kept separate and noted", async () => {
    const runtime = makeRuntime(
      [entry("gh", "github")],
      {
        gh: {
          git: [commit("r/a", "Shared", 2, { email: "shared@example.com", providerUserId: "5" })],
        },
      },
      [
        { id: "a", name: "A", emails: ["shared@example.com"], accounts: [] },
        { id: "b", name: "B", emails: ["shared@example.com"], accounts: [] },
      ],
    );
    const report = await new ActivityService(runtime).gitReport(query("git"), {
      sortKey: "commits",
    });
    expect(report.rows[0]?.identity).toBe("ambiguous");
    expect(report.rows[0]?.displayName).toBe("Shared");
    expect(report.notes.join("\n")).toMatch(/matches several identities \(a, b\)/);
  });

  test("disabled providers are not queried", async () => {
    const service = new ActivityService(
      makeRuntime([entry("gh", "github"), entry("gl", "gitlab", { enabled: false })], {
        gh: { git: [] },
        gl: { git: new Error("should not run") },
      }),
    );
    const report = await service.gitReport(query("git"), { sortKey: "commits" });
    expect(report.sources.map((s) => s.id)).toEqual(["gh"]);
    expect(report.failures).toEqual([]);
  });
});

describe("task aggregation", () => {
  const counts = (completed: number, in_progress: number, in_review: number) => ({
    completed,
    in_progress,
    in_review,
  });

  test("combines task counts across providers and reports unmapped statuses", async () => {
    const service = new ActivityService(
      makeRuntime([entry("jira", "jira"), entry("lin", "linear")], {
        jira: {
          tasks: {
            users: [
              {
                assignee: { displayName: "Ana", email: "ana@example.com" },
                counts: counts(2, 1, 0),
              },
            ],
            unmappedStatuses: [{ status: "Blocked", count: 3 }],
          },
        },
        lin: {
          tasks: {
            users: [
              {
                assignee: { displayName: "Ana", email: "ana@example.com" },
                counts: counts(1, 0, 4),
              },
            ],
            unmappedStatuses: [],
          },
        },
      }),
    );
    const report = await service.taskReport(query("tasks"), { sortKey: "completed" });
    expect(report.rows.map((r) => r.counts)).toEqual([counts(3, 1, 4)]);
    expect(report.notes.join("\n")).toContain("jira: excluded 3 task(s)");
    expect(report.notes.join("\n")).toContain("Blocked: 3");
  });

  test("status filter keeps only selected buckets and drops rows with nothing left", async () => {
    const service = new ActivityService(
      makeRuntime([entry("jira", "jira")], {
        jira: {
          tasks: {
            users: [
              { assignee: { displayName: "Ana", email: "a@example.com" }, counts: counts(2, 1, 0) },
              { assignee: { displayName: "Ben", email: "b@example.com" }, counts: counts(0, 3, 0) },
            ],
            unmappedStatuses: [],
          },
        },
      }),
    );
    const report = await service.taskReport(
      query("tasks", { statuses: ["completed", "in_review"] }),
      {
        sortKey: "completed",
      },
    );
    expect(report.rows.map((r) => [r.displayName, r.counts])).toEqual([["Ana", counts(2, 0, 0)]]);
  });

  test("email filter with missing identity data excludes the row and reports the limitation", async () => {
    const service = new ActivityService(
      makeRuntime([entry("jira", "jira")], {
        jira: {
          tasks: {
            users: [
              {
                assignee: { displayName: "NoEmail", providerUserId: "x" },
                counts: counts(5, 0, 0),
              },
              {
                assignee: { displayName: "Ana", email: "ana@example.com" },
                counts: counts(1, 0, 0),
              },
            ],
            unmappedStatuses: [],
          },
        },
      }),
    );
    const report = await service.taskReport(query("tasks", { emails: ["ana@example.com"] }), {
      sortKey: "completed",
    });
    expect(report.rows.map((r) => r.displayName)).toEqual(["Ana"]);
    expect(report.notes.join("\n")).toMatch(
      /jira: excluded 1 task row\(s\) with no email and no identity mapping/,
    );
  });

  test("email filter applies through an explicit account mapping when the provider has no email", async () => {
    const runtime = makeRuntime(
      [entry("jira", "jira")],
      {
        jira: {
          tasks: {
            users: [
              {
                assignee: { displayName: "Dana", providerUserId: "acc-d" },
                counts: counts(2, 0, 0),
              },
            ],
            unmappedStatuses: [],
          },
        },
      },
      [
        {
          id: "dana",
          name: "Dana Okafor",
          emails: ["dana@example.com"],
          accounts: [{ provider: "jira", userId: "acc-d" }],
        },
      ],
    );
    const report = await new ActivityService(runtime).taskReport(
      query("tasks", { emails: ["dana@example.com"] }),
      {
        sortKey: "completed",
      },
    );
    expect(report.rows.map((r) => r.displayName)).toEqual(["Dana Okafor"]);
    expect(report.notes).toEqual([]);
  });

  test("empty filtered result yields no rows and no failures", async () => {
    const service = new ActivityService(
      makeRuntime([entry("jira", "jira")], {
        jira: {
          tasks: {
            users: [
              { assignee: { displayName: "A", email: "a@example.com" }, counts: counts(1, 0, 0) },
            ],
            unmappedStatuses: [],
          },
        },
      }),
    );
    const report = await service.taskReport(query("tasks", { emails: ["nobody@example.com"] }), {
      sortKey: "completed",
    });
    expect(report.rows).toEqual([]);
    expect(report.failures).toEqual([]);
  });
});

describe("combined aggregation", () => {
  test("joins Git and task rows on identity, never on display name", async () => {
    const runtime = makeRuntime(
      [entry("gh", "github"), entry("jira", "jira")],
      {
        gh: {
          git: [
            commit("r/a", "Ana", 4, { email: "ana@example.com" }),
            commit("r/a", "Sam Lee", 2, { email: "sam@example.com" }),
          ],
        },
        jira: {
          tasks: {
            users: [
              {
                assignee: { displayName: "Ana Souza", providerUserId: "j-ana" },
                counts: { completed: 3, in_progress: 0, in_review: 0 },
              },
              {
                assignee: { displayName: "Sam Lee", email: "sam.lee@example.org" },
                counts: { completed: 1, in_progress: 0, in_review: 0 },
              },
            ],
            unmappedStatuses: [],
          },
        },
      },
      [
        {
          id: "ana",
          name: "Ana Souza",
          emails: ["ana@example.com"],
          accounts: [{ provider: "jira", userId: "j-ana" }],
        },
      ],
    );
    const report = await new ActivityService(runtime).combinedReport(query("all"), {
      sortKey: "commits",
    });
    const rows = report.rows.map((r) => [r.displayName, r.commits, r.tasks?.completed]);
    expect(rows).toEqual([
      ["Ana Souza", 4, 3],
      ["Sam Lee", 2, undefined],
      ["Sam Lee", undefined, 1],
    ]);
  });

  test("provider filter selecting one category notes the empty other category", async () => {
    const service = new ActivityService(
      makeRuntime([entry("gh", "github"), entry("jira", "jira")], {
        gh: { git: [commit("r/a", "A", 1, ana)] },
      }),
    );
    const report = await service.combinedReport(query("all", { providers: ["github"] }), {
      sortKey: "commits",
    });
    expect(report.sources.map((s) => s.id)).toEqual(["gh"]);
    expect(report.notes.join("\n")).toContain("No tasks providers are selected");
  });

  test("filters combine with AND across categories", async () => {
    const service = new ActivityService(
      makeRuntime([entry("gh", "github"), entry("gl", "gitlab")], {
        gh: { git: [commit("r/a", "Ana", 1, ana), commit("r/a", "Ben", 1, ben)] },
        gl: { git: [commit("r/b", "Ana", 7, ana)] },
      }),
    );
    const report = await service.combinedReport(
      query("all", { providers: ["gh"], emails: ["ana@example.com"] }),
      {
        sortKey: "commits",
      },
    );
    expect(report.rows.map((r) => [r.displayName, r.commits])).toEqual([["Ana", 1]]);
  });
});

describe("mock/live mixing", () => {
  test("refuses to mix mock and live sources unless allowed", async () => {
    const runtime = makeRuntime([entry("gh", "github"), entry("gl", "gitlab", { mode: "live" })], {
      gh: { git: [] },
      gl: { git: [] },
    });
    const service = new ActivityService(runtime);
    await expect(service.gitReport(query("git"), { sortKey: "commits" })).rejects.toThrow(
      UsageError,
    );
    const report = await service.gitReport(query("git"), {
      sortKey: "commits",
      allowMixedModes: true,
    });
    expect(report.sources.map((s) => s.mode)).toEqual(["mock", "live"]);
  });
});

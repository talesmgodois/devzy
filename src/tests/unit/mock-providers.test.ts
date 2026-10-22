import { describe, expect, test } from "bun:test";
import { periodFromDates } from "../../domain/period.ts";
import { GitHubMockGitProvider } from "../../services/providers/git/mock/github.mock.ts";
import { GitLabMockGitProvider } from "../../services/providers/git/mock/gitlab.mock.ts";
import { JiraMockTaskProvider } from "../../services/providers/tasks/mock/jira.mock.ts";
import { LinearMockTaskProvider } from "../../services/providers/tasks/mock/linear.mock.ts";

const NOW = new Date("2026-10-22T00:00:00Z");
const period = (since: string, to: string) => periodFromDates({ since, to }, 30, NOW).period;
const total = (rows: { commits: number }[]) => rows.reduce((s, r) => s + r.commits, 0);

describe("mock Git providers", () => {
  test("are deterministic for the same inputs", async () => {
    const q = { period: period("2026-09-01", "2026-09-30"), repositories: [] };
    const a = await new GitHubMockGitProvider("gh", "GH", {}).getCommitStats(q);
    const b = await new GitHubMockGitProvider("gh", "GH", {}).getCommitStats(q);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  test("different instance IDs produce different data", async () => {
    const q = { period: period("2026-09-01", "2026-09-30"), repositories: [] };
    const a = await new GitHubMockGitProvider("gh-1", "GH", {}).getCommitStats(q);
    const b = await new GitHubMockGitProvider("gh-2", "GH", {}).getCommitStats(q);
    expect(a).not.toEqual(b);
  });

  test("respect period boundaries: totals of adjacent sub-periods add up", async () => {
    const p = new GitLabMockGitProvider("gl", "GL", {});
    const whole = total(
      await p.getCommitStats({ period: period("2026-09-01", "2026-09-30"), repositories: [] }),
    );
    const first = total(
      await p.getCommitStats({ period: period("2026-09-01", "2026-09-15"), repositories: [] }),
    );
    const second = total(
      await p.getCommitStats({ period: period("2026-09-16", "2026-09-30"), repositories: [] }),
    );
    expect(first + second).toBe(whole);
  });

  test("returns one row per (repository, contributor) with positive counts", async () => {
    const rows = await new GitHubMockGitProvider("gh", "GH", {}).getCommitStats({
      period: period("2026-01-01", "2026-03-31"),
      repositories: [],
    });
    const keys = rows.map((r) => `${r.repository}|${r.author.providerUserId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.every((r) => Number.isInteger(r.commits) && r.commits > 0)).toBe(true);
  });

  test("repository pushdown and option overrides", async () => {
    const q = { period: period("2026-09-01", "2026-09-30"), repositories: ["acme/web"] };
    const rows = await new GitHubMockGitProvider("gh", "GH", {}).getCommitStats(q);
    expect(new Set(rows.map((r) => r.repository))).toEqual(new Set(["acme/web"]));
    const custom = await new GitHubMockGitProvider("gh", "GH", {
      repositories: ["me/one"],
    }).getCommitStats({
      ...q,
      repositories: [],
    });
    expect(new Set(custom.map((r) => r.repository))).toEqual(new Set(["me/one"]));
  });

  test("failReports simulates a provider failure", async () => {
    const p = new GitHubMockGitProvider("gh", "GH", { failReports: true });
    await expect(
      p.getCommitStats({ period: period("2026-09-01", "2026-09-02"), repositories: [] }),
    ).rejects.toThrow(/Simulated failure/);
  });

  test("rejects unknown options", () => {
    expect(() => new GitHubMockGitProvider("gh", "GH", { bogus: 1 })).toThrow();
  });
});

describe("mock task providers", () => {
  test("are deterministic, normalize statuses and report unmapped ones", async () => {
    const q = { period: period("2026-09-01", "2026-09-30") };
    const a = await new JiraMockTaskProvider("jira", "J", {}).getUserTaskStats(q);
    const b = await new JiraMockTaskProvider("jira", "J", {}).getUserTaskStats(q);
    expect(a).toEqual(b);
    expect(a.users.length).toBeGreaterThan(0);
    expect(a.unmappedStatuses.map((s) => s.status)).toEqual(["Blocked"]);
  });

  test("respect period boundaries: totals of adjacent sub-periods add up", async () => {
    const p = new LinearMockTaskProvider("lin", "L", {});
    const sum = async (since: string, to: string) =>
      (await p.getUserTaskStats({ period: period(since, to) })).users.reduce(
        (s, u) => s + u.counts.completed + u.counts.in_progress + u.counts.in_review,
        0,
      );
    expect((await sum("2026-09-01", "2026-09-10")) + (await sum("2026-09-11", "2026-09-30"))).toBe(
      await sum("2026-09-01", "2026-09-30"),
    );
  });
});

describe("mock health checks", () => {
  const signal = () => new AbortController().signal;

  test("healthy by default, unhealthy when configured", async () => {
    expect((await new JiraMockTaskProvider("j", "J", {}).healthCheck(signal())).ok).toBe(true);
    expect(
      (await new JiraMockTaskProvider("j", "J", { health: "unhealthy" }).healthCheck(signal())).ok,
    ).toBe(false);
  });

  test("error throws; timeout settles only when aborted", async () => {
    await expect(
      new GitHubMockGitProvider("g", "G", { health: "error" }).healthCheck(signal()),
    ).rejects.toThrow();
    const controller = new AbortController();
    const pending = new GitHubMockGitProvider("g", "G", { health: "timeout" }).healthCheck(
      controller.signal,
    );
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});

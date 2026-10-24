import { describe, expect, test } from "bun:test";
import { periodFromDates } from "../../domain/period.ts";
import { mergeStatusMaps } from "../../domain/tasks.ts";
import { DEFAULT_SETTINGS } from "../../services/config/schema.ts";
import type { FetchLike } from "../../services/providers/adapter.ts";
import {
  JIRA_MAX_PAGES,
  JiraLiveTaskProvider,
  jiraLiveAdapter,
  lastStatusChange,
} from "../../services/providers/tasks/jira.provider.ts";
import { JIRA_STATUS_MAP } from "../../services/providers/tasks/status-maps.ts";
import { json, recordingSleep, status, stubFetch } from "../http-stub.ts";

const TOKEN = "jira-api-token-ATATT3xFfGF0000000000";
const period = periodFromDates(
  { since: "2026-01-01", to: "2026-01-31" },
  30,
  new Date("2026-02-10Z"),
).period;

const issue = (
  status: string | null,
  assignee: { accountId: string; displayName?: string; emailAddress?: string } | null,
  changed: string | null,
  updated = "2026-01-15T10:00:00.000+0000",
) => ({
  key: "ENG-1",
  fields: {
    assignee,
    status: status === null ? null : { name: status },
    statuscategorychangedate: changed,
    updated,
  },
});

function provider(
  fetch: FetchLike,
  extra: {
    jql?: string;
    statusMap?: Record<string, "completed" | "in_progress" | "in_review">;
  } = {},
) {
  return new JiraLiveTaskProvider(
    "jira",
    "Jira",
    {
      baseUrl: "https://acme.atlassian.net",
      email: "bot@example.com",
      projects: ["ENG", "OPS"],
      jql: extra.jql,
      statusMap: mergeStatusMaps(JIRA_STATUS_MAP, extra.statusMap),
      token: TOKEN,
      tokenSource: "$JIRA_API_TOKEN",
      requestTimeoutMs: 1000,
      sleep: recordingSleep().sleep,
    },
    fetch,
  );
}

const ana = { accountId: "acc-ana", displayName: "Ana Souza", emailAddress: "ana@example.com" };
const dana = { accountId: "acc-dana", displayName: "Dana Okafor" };

describe("JiraLiveTaskProvider", () => {
  test("builds an enhanced-search request with Basic auth and minimal fields", async () => {
    const { fetch, calls } = stubFetch(() => json({ issues: [], isLast: true }));
    await provider(fetch, { jql: "labels = backend" }).getUserTaskStats({ period });
    const url = calls[0]?.url as URL;
    expect(url.origin + url.pathname).toBe("https://acme.atlassian.net/rest/api/3/search/jql");
    expect(url.searchParams.get("jql")).toBe(
      'project in ("ENG", "OPS") AND updated >= "2025-12-31" AND created < "2026-02-02" AND (labels = backend) ORDER BY key ASC',
    );
    expect(url.searchParams.get("fields")).toBe(
      "assignee,status,statuscategorychangedate,updated,created",
    );
    expect(url.searchParams.get("expand")).toBe("changelog");
    expect(url.searchParams.get("maxResults")).toBe("50");
    expect(calls[0]?.headers["Authorization"]).toBe(
      `Basic ${Buffer.from(`bot@example.com:${TOKEN}`).toString("base64")}`,
    );
  });

  test("paginates with nextPageToken, normalizes statuses and reports unmapped/unassigned", async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.searchParams.get("nextPageToken") === null
        ? json({
            issues: [
              issue("Done", ana, "2026-01-01T00:00:00.000+0000"), // at since: counted
              issue("In Review", ana, "2026-01-20T09:00:00.000+0100"),
              issue("Blocked", dana, "2026-01-05T00:00:00.000+0000"),
              issue("In Progress", null, "2026-01-06T00:00:00.000+0000"),
            ],
            nextPageToken: "tok-2",
          })
        : json({
            issues: [
              issue("QA", dana, null, "2026-01-30T12:00:00.000+0000"), // falls back to `updated`
              issue("Done", dana, "2026-02-01T00:00:00.000+0000"), // at until: excluded
              issue("Done", dana, "2025-12-31T23:59:59.000+0000"), // before since: excluded
            ],
            isLast: true,
          }),
    );
    const result = await provider(fetch).getUserTaskStats({ period });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url.searchParams.get("nextPageToken")).toBe("tok-2");
    const byUser = Object.fromEntries(
      result.users.map((u) => [u.assignee.providerUserId, u.counts]),
    );
    expect(byUser).toEqual({
      "acc-ana": { completed: 1, in_progress: 0, in_review: 1 },
      "acc-dana": { completed: 0, in_progress: 0, in_review: 1 },
    });
    const anaUser = result.users.find((u) => u.assignee.providerUserId === "acc-ana");
    expect(anaUser?.assignee).toEqual({
      displayName: "Ana Souza",
      email: "ana@example.com",
      providerUserId: "acc-ana",
    });
    expect(
      result.users.find((u) => u.assignee.providerUserId === "acc-dana")?.assignee.email,
    ).toBeUndefined();
    expect(result.unmappedStatuses).toEqual([{ status: "Blocked", count: 1 }]);
    expect(result.excluded).toEqual([{ reason: "without an assignee", count: 1 }]);
  });

  test("statusMap overrides defaults case-insensitively and unknown statuses stay unmapped", async () => {
    const { fetch } = stubFetch(() =>
      json({
        issues: [
          issue("blocked", ana, "2026-01-02T00:00:00.000+0000"),
          issue("DONE", ana, "2026-01-02T00:00:00.000+0000"),
          issue("Won't Do", ana, "2026-01-02T00:00:00.000+0000"),
        ],
        isLast: true,
      }),
    );
    const result = await provider(fetch, {
      statusMap: { Blocked: "in_progress", done: "in_review" },
    }).getUserTaskStats({
      period,
    });
    expect(result.users[0]?.counts).toEqual({ completed: 0, in_progress: 1, in_review: 1 });
    expect(result.unmappedStatuses).toEqual([{ status: "Won't Do", count: 1 }]);
  });

  test("guards against repeated page tokens and enforces the page cap", async () => {
    const loop = stubFetch(() => json({ issues: [], nextPageToken: "same", isLast: false }));
    await expect(provider(loop.fetch).getUserTaskStats({ period })).rejects.toThrow(
      /repeated page token/,
    );

    let n = 0;
    const endless = stubFetch(() => json({ issues: [], nextPageToken: `t${++n}`, isLast: false }));
    await expect(provider(endless.fetch).getUserTaskStats({ period })).rejects.toThrow(
      `More than ${JIRA_MAX_PAGES * 50} Jira issues`,
    );
  });

  test.each([
    [400, /HTTP 400/],
    [401, /rejected the credentials.*\$JIRA_API_TOKEN/],
    [403, /denied access/],
    [429, /rate limit exceeded/],
    [503, /server error/],
  ])("HTTP %d is a clear error without credentials", async (code, pattern) => {
    const { fetch } = stubFetch(() => status(code, {}, TOKEN));
    const error = (await provider(fetch)
      .getUserTaskStats({ period })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(pattern);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(Buffer.from(`bot@example.com:${TOKEN}`).toString("base64"));
  });

  test("health check: myself and each project", async () => {
    const { fetch } = stubFetch((url) =>
      url.pathname.endsWith("/myself")
        ? json({ accountId: "acc-bot", displayName: "Devzy Bot" })
        : url.pathname.endsWith("/project/ENG")
          ? json({ key: "ENG" })
          : status(404),
    );
    const result = await provider(fetch).healthCheck(new AbortController().signal);
    expect(result).toEqual({
      ok: false,
      message: "Authenticated as Devzy Bot; cannot access OPS (HTTP 404).",
    });
  });
});

describe("jiraLiveAdapter", () => {
  const valid = {
    baseUrl: "https://acme.atlassian.net",
    email: "me@example.com",
    projects: ["ENG"],
  };
  const parse = (o: unknown) => jiraLiveAdapter.optionsSchema.safeParse(o).success;

  test("options validation", () => {
    expect(parse(valid)).toBe(true);
    expect(parse({ ...valid, projects: [] })).toBe(false);
    expect(parse({ ...valid, projects: ["bad key"] })).toBe(false);
    expect(parse({ ...valid, email: "nope" })).toBe(false);
    expect(parse({ ...valid, baseUrl: "https://me:pw@acme.atlassian.net" })).toBe(false);
    expect(parse({ ...valid, statusMap: { Blocked: "done" } })).toBe(false);
    expect(parse({ ...valid, statusMap: { Blocked: "in_progress" }, jql: "labels = x" })).toBe(
      true,
    );
    expect(parse({ email: "me@example.com", projects: ["ENG"] })).toBe(false);
  });

  test("create() requires a token and merges statusMap over defaults", async () => {
    const ctx = {
      id: "j",
      name: "J",
      type: "jira",
      options: { ...valid, statusMap: { Blocked: "in_progress" } },
      tokenSource: "$JIRA_API_TOKEN",
      settings: DEFAULT_SETTINGS,
    };
    expect(() =>
      jiraLiveAdapter.create({
        ...ctx,
        token: undefined,
        fetch: () => Promise.reject(new Error()),
      }),
    ).toThrow(/No Jira API token/);
    const { fetch } = stubFetch(() =>
      json({ issues: [issue("Blocked", ana, "2026-01-02T00:00:00.000+0000")], isLast: true }),
    );
    const p = jiraLiveAdapter.create({ ...ctx, token: TOKEN, fetch });
    if (p.category !== "tasks") throw new Error("expected a task provider");
    expect((await p.getUserTaskStats({ period })).users[0]?.counts.in_progress).toBe(1);
  });
});

describe("lastStatusChange (changelog-based)", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  const fields = {
    statuscategorychangedate: "2025-11-01T00:00:00.000+0000",
    updated: "2026-01-20T00:00:00.000+0000",
    created: "2025-10-01T00:00:00.000+0000",
  };
  const history = (created: string, field: string) => ({
    created,
    items: [{ field, fieldId: field }],
  });
  const at = (d: Date | undefined) => d?.toISOString();

  test("uses the newest status transition, even within one status category", () => {
    const issue = {
      fields,
      changelog: {
        total: 3,
        histories: [
          history("2026-01-15T10:00:00.000+0000", "assignee"),
          history("2026-01-12T09:00:00.000+0000", "status"), // In Progress -> In Code Review
          history("2025-11-01T00:00:00.000+0000", "status"), // To Do -> In Progress
        ],
      },
    };
    expect(at(lastStatusChange(issue, since))).toBe("2026-01-12T09:00:00.000Z");
  });

  test("complete changelog without a status change: the creation date", () => {
    const issue = {
      fields,
      changelog: { total: 1, histories: [history("2026-01-15T10:00:00.000+0000", "summary")] },
    };
    expect(at(lastStatusChange(issue, since))).toBe("2025-10-01T00:00:00.000Z");
  });

  test("truncated changelog older than the period: excluded via the oldest entry", () => {
    const issue = {
      fields,
      changelog: { total: 60, histories: [history("2025-12-20T00:00:00.000+0000", "summary")] },
    };
    const result = lastStatusChange(issue, since);
    expect(result && result < since).toBe(true);
  });

  test("truncated changelog entirely inside the period, or no changelog: date-field fallback", () => {
    const truncated = {
      fields,
      changelog: { total: 60, histories: [history("2026-01-10T00:00:00.000+0000", "summary")] },
    };
    expect(at(lastStatusChange(truncated, since))).toBe("2025-11-01T00:00:00.000Z");
    expect(at(lastStatusChange({ fields }, since))).toBe("2025-11-01T00:00:00.000Z");
    expect(
      at(lastStatusChange({ fields: { ...fields, statuscategorychangedate: null } }, since)),
    ).toBe("2026-01-20T00:00:00.000Z");
  });
});

describe("JiraLiveTaskProvider with changelogs", () => {
  test("counts a move into In Code Review inside the period even when the category date is older", async () => {
    const { fetch } = stubFetch(() =>
      json({
        isLast: true,
        issues: [
          {
            fields: {
              assignee: ana,
              status: { name: "In Code Review" },
              statuscategorychangedate: "2025-12-01T00:00:00.000+0000",
              updated: "2026-01-10T00:00:00.000+0000",
              created: "2025-11-20T00:00:00.000+0000",
            },
            changelog: {
              total: 2,
              histories: [
                {
                  created: "2026-01-10T00:00:00.000+0000",
                  items: [{ field: "status", fieldId: "status" }],
                },
                {
                  created: "2025-12-01T00:00:00.000+0000",
                  items: [{ field: "status", fieldId: "status" }],
                },
              ],
            },
          },
          {
            fields: {
              assignee: dana,
              status: { name: "Ready for Test" },
              statuscategorychangedate: "2026-01-05T00:00:00.000+0000",
              updated: "2026-01-25T00:00:00.000+0000",
              created: "2025-11-20T00:00:00.000+0000",
            },
            // Edited in the period, but the status last changed before it.
            changelog: {
              total: 2,
              histories: [
                {
                  created: "2026-01-25T00:00:00.000+0000",
                  items: [{ field: "summary", fieldId: "summary" }],
                },
                {
                  created: "2025-12-28T00:00:00.000+0000",
                  items: [{ field: "status", fieldId: "status" }],
                },
              ],
            },
          },
        ],
      }),
    );
    const result = await provider(fetch).getUserTaskStats({ period });
    expect(result.users).toEqual([
      {
        assignee: { displayName: "Ana Souza", email: "ana@example.com", providerUserId: "acc-ana" },
        counts: { completed: 0, in_progress: 0, in_review: 1 },
      },
    ]);
    expect(result.unmappedStatuses).toEqual([]);
  });
});

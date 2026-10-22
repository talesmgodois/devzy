import { describe, expect, test } from "bun:test";
import { periodFromDates } from "../../domain/period.ts";
import { mergeStatusMaps } from "../../domain/tasks.ts";
import type { FetchLike } from "../../services/providers/adapter.ts";
import {
  classifyAssignee,
  OPENPROJECT_MAX_PAGES,
  OpenProjectLiveTaskProvider,
  openprojectLiveAdapter,
} from "../../services/providers/tasks/openproject.provider.ts";
import { OPENPROJECT_STATUS_MAP } from "../../services/providers/tasks/status-maps.ts";
import { json, recordingSleep, status, stubFetch } from "../http-stub.ts";

const TOKEN = "op-api-key-0123456789abcdef0123456789abcdef";
const period = periodFromDates(
  { since: "2026-01-01", to: "2026-01-31" },
  30,
  new Date("2026-02-10Z"),
).period;

const wp = (
  id: number,
  statusTitle: string | null,
  assigneeHref: string | null,
  title: string | null,
  updatedAt: string,
) => ({
  id,
  updatedAt,
  _links: {
    status: statusTitle === null ? null : { href: "/api/v3/statuses/1", title: statusTitle },
    assignee: { href: assigneeHref, title },
  },
});

const page = (elements: unknown[], total: number, pageSize = 2) =>
  json({ total, count: elements.length, pageSize, _embedded: { elements } });

function provider(
  fetch: FetchLike,
  projects = ["website"],
  statusMap?: Record<string, "completed" | "in_progress" | "in_review">,
) {
  return new OpenProjectLiveTaskProvider(
    "op",
    "OpenProject",
    {
      baseUrl: "https://pm.example.com/openproject",
      projects,
      statusMap: mergeStatusMaps(OPENPROJECT_STATUS_MAP, statusMap),
      token: TOKEN,
      tokenSource: "$OPENPROJECT_API_KEY",
      requestTimeoutMs: 1000,
      sleep: recordingSleep().sleep,
    },
    fetch,
  );
}

describe("classifyAssignee", () => {
  test("distinguishes users, groups, placeholders and none", () => {
    expect(classifyAssignee("/api/v3/users/42")).toEqual({ kind: "user", id: "42" });
    expect(classifyAssignee("/api/v3/groups/5")).toEqual({ kind: "group", id: "5" });
    expect(classifyAssignee("/api/v3/placeholder_users/3")).toEqual({
      kind: "placeholder",
      id: "3",
    });
    expect(classifyAssignee(null)).toEqual({ kind: "none" });
  });
});

describe("OpenProjectLiveTaskProvider", () => {
  test("builds the request with filters, page-number offset and apikey Basic auth", async () => {
    const { fetch, calls } = stubFetch(() => page([], 0));
    await provider(fetch).getUserTaskStats({ period });
    const url = calls[0]?.url as URL;
    expect(url.origin + url.pathname).toBe(
      "https://pm.example.com/openproject/api/v3/projects/website/work_packages",
    );
    expect(JSON.parse(url.searchParams.get("filters") ?? "")).toEqual([
      { updatedAt: { operator: "<>d", values: ["2025-12-31", "2026-02-01"] } },
    ]);
    expect(url.searchParams.get("offset")).toBe("1");
    expect(url.searchParams.get("pageSize")).toBe("100");
    expect(calls[0]?.headers["Authorization"]).toBe(
      `Basic ${Buffer.from(`apikey:${TOKEN}`).toString("base64")}`,
    );
  });

  test("paginates by page number, maps assignees and statuses, excludes non-users", async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.searchParams.get("offset") === "1"
        ? page(
            [
              wp(1, "Closed", "/api/v3/users/7", "Ana Souza", "2026-01-01T00:00:00Z"),
              wp(2, "In testing", "/api/v3/users/7", "Ana Souza", "2026-01-15T12:00:00Z"),
            ],
            5,
          )
        : url.searchParams.get("offset") === "2"
          ? page(
              [
                wp(3, "Rejected", "/api/v3/users/9", "Ivo", "2026-01-10T00:00:00Z"),
                wp(4, "In progress", null, null, "2026-01-11T00:00:00Z"),
              ],
              5,
            )
          : page(
              [wp(5, "In progress", "/api/v3/groups/2", "Backend team", "2026-01-12T00:00:00Z")],
              5,
            ),
    );
    const result = await provider(fetch).getUserTaskStats({ period });
    expect(calls.map((c) => c.url.searchParams.get("offset"))).toEqual(["1", "2", "3"]);
    expect(result.users).toEqual([
      {
        assignee: { displayName: "Ana Souza", providerUserId: "7" },
        counts: { completed: 1, in_progress: 0, in_review: 1 },
      },
    ]);
    expect(result.unmappedStatuses).toEqual([{ status: "Rejected", count: 1 }]);
    expect(result.excluded).toEqual([
      { reason: "without an assignee", count: 1 },
      { reason: "assigned to a group or placeholder user", count: 1 },
    ]);
  });

  test("re-checks the exact period locally and applies statusMap overrides", async () => {
    const { fetch } = stubFetch(() =>
      page(
        [
          wp(1, "On hold", "/api/v3/users/7", "Ana", "2026-01-31T23:59:59Z"),
          wp(2, "Closed", "/api/v3/users/7", "Ana", "2026-02-01T00:00:00Z"),
          wp(3, "Closed", "/api/v3/users/7", "Ana", "2025-12-31T23:00:00Z"),
        ],
        3,
        100,
      ),
    );
    const result = await provider(fetch, ["website"], {
      "on hold": "in_progress",
    }).getUserTaskStats({ period });
    expect(result.users[0]?.counts).toEqual({ completed: 0, in_progress: 1, in_review: 0 });
  });

  test("queries each project and enforces the page cap", async () => {
    const two = stubFetch(() => page([], 0));
    await provider(two.fetch, ["website", "42"]).getUserTaskStats({ period });
    expect(two.calls.map((c) => c.url.pathname.split("/").at(-2))).toEqual(["website", "42"]);

    const endless = stubFetch(() =>
      page([wp(1, "Closed", null, null, "2026-01-02T00:00:00Z")], 1_000_000, 1),
    );
    await expect(provider(endless.fetch).getUserTaskStats({ period })).rejects.toThrow(
      `more than ${OPENPROJECT_MAX_PAGES} pages`,
    );
  });

  test.each([
    [401, /rejected the credentials.*\$OPENPROJECT_API_KEY/],
    [403, /denied access to project website/],
    [404, /project website was not found on OpenProject/],
    [504, /server error/],
  ])("HTTP %d is a clear error without credentials", async (code, pattern) => {
    const { fetch } = stubFetch(() => status(code, {}, TOKEN));
    const error = (await provider(fetch)
      .getUserTaskStats({ period })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(pattern);
    expect(error.message).not.toContain(TOKEN);
  });

  test("health check", async () => {
    const { fetch } = stubFetch((url) =>
      url.pathname.endsWith("/users/me")
        ? json({ id: 1, login: "devzy", name: "Devzy" })
        : json({ id: 3 }),
    );
    expect(await provider(fetch).healthCheck(new AbortController().signal)).toEqual({
      ok: true,
      message: "Authenticated as devzy; 1/1 projects accessible.",
    });
  });
});

describe("openprojectLiveAdapter", () => {
  test("options validation", () => {
    const parse = (o: unknown) => openprojectLiveAdapter.optionsSchema.safeParse(o).success;
    expect(parse({ baseUrl: "https://pm.example.com", projects: ["website", "42"] })).toBe(true);
    expect(parse({ baseUrl: "https://pm.example.com", projects: [] })).toBe(false);
    expect(parse({ projects: ["website"] })).toBe(false);
    expect(parse({ baseUrl: "https://pm.example.com", projects: ["has space"] })).toBe(false);
    expect(
      parse({
        baseUrl: "https://pm.example.com",
        projects: ["w"],
        statusMap: { Closed: "closed" },
      }),
    ).toBe(false);
  });
});

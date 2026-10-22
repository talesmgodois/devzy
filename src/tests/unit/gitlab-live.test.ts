import { describe, expect, test } from "bun:test";
import { periodFromDates } from "../../domain/period.ts";
import { DEFAULT_SETTINGS } from "../../services/config/schema.ts";
import type { FetchLike } from "../../services/providers/adapter.ts";
import {
  GITLAB_MAX_PAGES,
  GitLabLiveGitProvider,
  gitlabLiveAdapter,
} from "../../services/providers/git/gitlab.provider.ts";
import { json, recordingSleep, status, stubFetch } from "../http-stub.ts";

const TOKEN = "glpat-testtoken000000000000";
const period = periodFromDates(
  { since: "2026-01-01", to: "2026-01-31" },
  30,
  new Date("2026-02-10Z"),
).period;

const commit = (name: string | null, email: string | null, committed: string) => ({
  author_name: name,
  author_email: email,
  committed_date: committed,
  authored_date: committed,
});

function provider(fetch: FetchLike, projects = ["acme/api"], baseUrl = "https://gitlab.com") {
  return new GitLabLiveGitProvider(
    "gl",
    "GitLab",
    {
      baseUrl,
      projects,
      token: TOKEN,
      tokenSource: "$GITLAB_TOKEN",
      requestTimeoutMs: 1000,
      sleep: recordingSleep().sleep,
    },
    fetch,
  );
}

const errorOf = async (p: Promise<unknown>) =>
  (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as Error;

describe("GitLabLiveGitProvider", () => {
  test("builds the request, paginates with x-next-page and groups by email", async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.searchParams.get("page") === "1"
        ? json(
            [
              commit("Ana", "Ana@Example.com", "2026-01-01T00:00:00.000Z"), // exactly at since: counted
              commit("Ben", "ben@example.com", "2026-01-10T10:00:00+01:00"),
              commit("Old", "old@example.com", "2026-02-01T00:00:00.000Z"), // exactly at until: excluded
            ],
            { headers: { "x-next-page": "2", "x-page": "1" } },
          )
        : json(
            [
              commit("Ana Souza", "ana@example.com", "2026-01-31T23:59:59.000Z"),
              commit(null, null, "2026-01-05T00:00:00Z"),
            ],
            {
              headers: { "x-next-page": "", "x-page": "2" },
            },
          ),
    );
    const rows = await provider(fetch).getCommitStats({ period, repositories: [] });

    expect(calls).toHaveLength(2);
    const first = calls[0]?.url as URL;
    expect(
      first
        .toString()
        .startsWith("https://gitlab.com/api/v4/projects/acme%2Fapi/repository/commits?"),
    ).toBe(true);
    expect(first.searchParams.get("since")).toBe("2026-01-01T00:00:00.000Z");
    expect(first.searchParams.get("until")).toBe("2026-01-31T23:59:59.000Z");
    expect(first.searchParams.get("per_page")).toBe("100");
    expect(calls[0]?.headers["PRIVATE-TOKEN"]).toBe(TOKEN);

    const byKey = Object.fromEntries(
      rows.map((r) => [r.author.email ?? r.author.displayName, r.commits]),
    );
    expect(byKey).toEqual({ "Ana@Example.com": 2, "ben@example.com": 1, "Unknown author": 1 });
    expect(
      rows.every((r) => r.repository === "acme/api" && r.author.providerUserId === undefined),
    ).toBe(true);
  });

  test("supports self-managed instances under a sub-path and nested groups", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    await provider(fetch, ["grp/sub/proj"], "https://git.example.com/gitlab").getCommitStats({
      period,
      repositories: [],
    });
    expect(calls[0]?.url.pathname).toBe(
      "/gitlab/api/v4/projects/grp%2Fsub%2Fproj/repository/commits",
    );
  });

  test("follows same-origin Link headers and refuses other hosts", async () => {
    const ok = stubFetch((url) =>
      url.searchParams.get("page") === "1"
        ? json([], {
            headers: {
              link: '<https://gitlab.com/api/v4/projects/acme%2Fapi/repository/commits?page=2>; rel="next"',
            },
          })
        : json([]),
    );
    await provider(ok.fetch).getCommitStats({ period, repositories: [] });
    expect(ok.calls).toHaveLength(2);

    const evil = stubFetch(() =>
      json([], { headers: { link: '<https://evil.example.com/x>; rel="next"' } }),
    );
    await expect(provider(evil.fetch).getCommitStats({ period, repositories: [] })).rejects.toThrow(
      /different host/,
    );
    expect(evil.calls).toHaveLength(1);
  });

  test("stops at the page cap with an error instead of truncating", async () => {
    const { fetch } = stubFetch((url) =>
      json([], { headers: { "x-next-page": String(Number(url.searchParams.get("page")) + 1) } }),
    );
    await expect(provider(fetch).getCommitStats({ period, repositories: [] })).rejects.toThrow(
      `more than ${GITLAB_MAX_PAGES * 100} commits`,
    );
  });

  test("--repo pushdown only narrows configured projects", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    await provider(fetch, ["acme/api", "acme/web"]).getCommitStats({
      period,
      repositories: ["acme/web", "other/x"],
    });
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/v4/projects/acme%2Fweb/repository/commits",
    ]);
  });

  test("empty repository (404 on commits, project accessible) yields no rows", async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.pathname.endsWith("/commits")
        ? status(404)
        : json({ path_with_namespace: "acme/api", empty_repo: true }),
    );
    expect(await provider(fetch).getCommitStats({ period, repositories: [] })).toEqual([]);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/v4/projects/acme%2Fapi/repository/commits",
      "/api/v4/projects/acme%2Fapi",
    ]);
  });

  test.each([
    [401, /rejected the credentials.*\$GITLAB_TOKEN/],
    [403, /denied access to project acme\/api/],
    [404, /project acme\/api was not found on GitLab/],
    [429, /rate limit exceeded/],
    [500, /server error/],
  ])("HTTP %d gives a clear error without the token", async (code, pattern) => {
    const { fetch } = stubFetch(() => status(code, {}, TOKEN));
    const error = await errorOf(provider(fetch).getCommitStats({ period, repositories: [] }));
    expect(error.message).toMatch(pattern);
    expect(error.message).not.toContain(TOKEN);
  });

  test("health check: user and every project", async () => {
    const { fetch } = stubFetch((url) =>
      url.pathname === "/api/v4/user"
        ? json({ username: "ana" })
        : url.pathname.endsWith("acme%2Fapi")
          ? json({ path_with_namespace: "acme/api" })
          : status(404),
    );
    const signal = new AbortController().signal;
    expect(await provider(fetch).healthCheck(signal)).toEqual({
      ok: true,
      message: "Authenticated as ana; 1/1 projects accessible.",
    });
    const partial = await provider(fetch, ["acme/api", "acme/secret"]).healthCheck(signal);
    expect(partial).toEqual({
      ok: false,
      message: "Authenticated as ana; cannot access acme/secret (HTTP 404).",
    });
    await expect(provider(stubFetch(() => status(401)).fetch).healthCheck(signal)).rejects.toThrow(
      /HTTP 401/,
    );
  });
});

describe("gitlabLiveAdapter", () => {
  test("options validation", () => {
    const parse = (o: unknown) => gitlabLiveAdapter.optionsSchema.safeParse(o).success;
    expect(parse({ projects: ["acme/api"] })).toBe(true);
    expect(parse({})).toBe(false);
    expect(parse({ projects: [] })).toBe(false);
    expect(parse({ projects: ["noslash"] })).toBe(false);
    expect(parse({ projects: ["a/b"], baseUrl: "ftp://x" })).toBe(false);
    expect(parse({ projects: ["a/b"], baseUrl: "https://u:p@gitlab.example.com" })).toBe(false);
  });

  test("create() requires a token", () => {
    expect(() =>
      gitlabLiveAdapter.create({
        id: "gl",
        name: "GL",
        type: "gitlab",
        options: { projects: ["a/b"] },
        token: undefined,
        tokenSource: undefined,
        settings: DEFAULT_SETTINGS,
        fetch: () => Promise.reject(new Error("x")),
      }),
    ).toThrow(/No GitLab token/);
  });
});

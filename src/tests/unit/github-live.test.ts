import { describe, expect, test } from "bun:test";
import { periodFromDates } from "../../domain/period.ts";
import { DEFAULT_SETTINGS } from "../../services/config/schema.ts";
import type { FetchLike } from "../../services/providers/adapter.ts";
import {
  GitHubLiveGitProvider,
  githubLiveAdapter,
} from "../../services/providers/git/github.provider.ts";

const TOKEN = "ghp_testtoken0000000000000000000000";
const period = periodFromDates(
  { since: "2026-01-01", to: "2026-01-31" },
  30,
  new Date("2026-02-10Z"),
).period;

interface Call {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(routes: (url: URL) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, headers: { ...(init?.headers as Record<string, string>) } });
    return routes(new URL(input));
  };
  return { fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const commitItem = (
  id: number | null,
  login: string | null,
  name: string,
  email: string,
  date: string,
) => ({
  author: id === null ? null : { id, login },
  commit: { author: { name, email, date }, committer: { name, email, date } },
});

function provider(
  fetch: FetchLike,
  repositories = ["acme/api"],
  baseUrl = "https://api.github.com",
) {
  return new GitHubLiveGitProvider(
    "gh",
    "GitHub",
    { baseUrl, repositories, token: TOKEN, tokenSource: "$GITHUB_TOKEN", requestTimeoutMs: 1000 },
    fetch,
  );
}

describe("GitHubLiveGitProvider", () => {
  test("requests commits for the period, follows pagination and groups by account", async () => {
    const { fetch, calls } = stubFetch((url) => {
      if (url.searchParams.get("page") === "2") {
        return json([
          commitItem(1, "asouza", "Ana Souza", "ana@example.com", "2026-01-20T10:00:00Z"),
        ]);
      }
      return json(
        [
          commitItem(1, "asouza", "Ana Souza", "ana@example.com", "2026-01-02T10:00:00Z"),
          commitItem(2, "bcarter", "Ben", "ben@example.com", "2026-01-03T10:00:00Z"),
          commitItem(null, null, "Unlinked", "x@example.com", "2026-01-04T10:00:00Z"),
          // Outside the half-open window: must not be counted.
          commitItem(2, "bcarter", "Ben", "ben@example.com", "2026-02-01T00:00:00Z"),
        ],
        { headers: { link: '<https://api.github.com/repos/acme/api/commits?page=2>; rel="next"' } },
      );
    });
    const rows = await provider(fetch).getCommitStats({ period, repositories: [] });

    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]?.url ?? "");
    expect(first.pathname).toBe("/repos/acme/api/commits");
    expect(first.searchParams.get("since")).toBe("2026-01-01T00:00:00.000Z");
    expect(first.searchParams.get("until")).toBe("2026-01-31T23:59:59.000Z");
    expect(calls[0]?.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);

    const byUser = Object.fromEntries(
      rows.map((r) => [r.author.username ?? r.author.email, r.commits]),
    );
    expect(byUser).toEqual({ asouza: 2, bcarter: 1, "x@example.com": 1 });
    expect(rows.find((r) => r.author.username === "asouza")?.author).toMatchObject({
      providerUserId: "1",
      email: "ana@example.com",
    });
  });

  test("repository filter intersects configured repositories (never broadens)", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    await provider(fetch, ["acme/api", "acme/web"]).getCommitStats({
      period,
      repositories: ["acme/web", "other/x"],
    });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/repos/acme/web/commits"]);
  });

  test("an empty repository (409) yields no rows", async () => {
    const { fetch } = stubFetch(() => new Response("{}", { status: 409 }));
    expect(await provider(fetch).getCommitStats({ period, repositories: [] })).toEqual([]);
  });

  test.each([
    [401, {}, /rejected the credentials.*\$GITHUB_TOKEN/],
    [
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1767225600" },
      /rate limit exceeded/,
    ],
    [403, {}, /denied access/],
    [404, {}, /acme\/api was not found/],
    [500, {}, /HTTP 500/],
  ])(
    "maps HTTP %d to a clear error without leaking the token",
    async (status, headers, pattern) => {
      const { fetch } = stubFetch(() => new Response(`{"echo":"${TOKEN}"}`, { status, headers }));
      const error = (await provider(fetch)
        .getCommitStats({ period, repositories: [] })
        .catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(pattern);
      expect(error.message).not.toContain(TOKEN);
    },
  );

  test("refuses to send the token to a different host via pagination", async () => {
    const { fetch, calls } = stubFetch(() =>
      json([], { headers: { link: '<https://evil.example.com/steal?page=2>; rel="next"' } }),
    );
    await expect(provider(fetch).getCommitStats({ period, repositories: [] })).rejects.toThrow(
      /different host/,
    );
    expect(calls).toHaveLength(1);
  });

  test("network failures become provider errors", async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError("connection refused"));
    await expect(provider(fetch).getCommitStats({ period, repositories: [] })).rejects.toThrow(
      /Could not reach GitHub/,
    );
  });

  test("unexpected response shape is rejected", async () => {
    const { fetch } = stubFetch(() => json({ message: "not a list" }));
    await expect(provider(fetch).getCommitStats({ period, repositories: [] })).rejects.toThrow(
      /Unexpected response/,
    );
  });

  test("supports GitHub Enterprise base URLs with a path", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    await provider(fetch, ["acme/api"], "https://ghe.example.com/api/v3").getCommitStats({
      period,
      repositories: [],
    });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v3/repos/acme/api/commits");
  });

  test("health check: authenticated user and repository access", async () => {
    const { fetch } = stubFetch((url) => {
      if (url.pathname === "/user") return json({ login: "octocat" });
      if (url.pathname === "/repos/acme/api") return json({});
      return new Response("{}", { status: 404 });
    });
    const healthy = await provider(fetch).healthCheck(new AbortController().signal);
    expect(healthy).toEqual({
      ok: true,
      message: "Authenticated as octocat; 1/1 repositories accessible.",
    });
    const partial = await provider(fetch, ["acme/api", "acme/private"]).healthCheck(
      new AbortController().signal,
    );
    expect(partial.ok).toBe(false);
    expect(partial.message).toContain("acme/private (HTTP 404)");
  });

  test("health check reports bad credentials", async () => {
    const { fetch } = stubFetch(() => new Response("{}", { status: 401 }));
    await expect(provider(fetch).healthCheck(new AbortController().signal)).rejects.toThrow(
      /HTTP 401/,
    );
  });
});

describe("githubLiveAdapter options", () => {
  test("requires repositories and validates the base URL", () => {
    expect(githubLiveAdapter.optionsSchema.safeParse({}).success).toBe(false);
    expect(
      githubLiveAdapter.optionsSchema.safeParse({ repositories: ["acme/api"], baseUrl: "ftp://x" })
        .success,
    ).toBe(false);
    expect(
      githubLiveAdapter.optionsSchema.safeParse({
        repositories: ["acme/api"],
        baseUrl: "https://user:pw@x.com",
      }).success,
    ).toBe(false);
    expect(githubLiveAdapter.optionsSchema.safeParse({ repositories: ["acme/api"] }).success).toBe(
      true,
    );
  });

  test("create() requires a token", () => {
    expect(() =>
      githubLiveAdapter.create({
        id: "gh",
        name: "GH",
        type: "github",
        options: { repositories: ["acme/api"] },
        token: undefined,
        tokenSource: undefined,
        settings: DEFAULT_SETTINGS,
        fetch: () => Promise.reject(new Error("x")),
      }),
    ).toThrow(/No GitHub token/);
  });
});

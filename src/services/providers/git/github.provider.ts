import { z } from "zod";
import type { GitCommitStats } from "../../../domain/git.ts";
import { type ContributorRef, normalizeEmail } from "../../../domain/identity.ts";
import { isWithinPeriod } from "../../../domain/period.ts";
import type { AdapterContext, AdapterDefinition, FetchLike } from "../adapter.ts";
import type { HealthCheckable, HealthCheckResult } from "../base.interface.ts";
import type { GitProvider, GitStatsQuery } from "./git.interface.ts";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const GITHUB_DEFAULT_BASE_URL = "https://api.github.com";
/** 100 commits per page; more than this per repository and period is rejected rather than truncated. */
export const GITHUB_MAX_PAGES = 50;

export const githubLiveOptionsSchema = z.strictObject({
  /** API root; change for GitHub Enterprise Server (e.g. https://ghe.example.com/api/v3). */
  baseUrl: z
    .string()
    .refine(isHttpUrl, { error: "must be an http(s) URL" })
    .default(GITHUB_DEFAULT_BASE_URL),
  /** Repositories to report on, as owner/name. */
  repositories: z
    .array(z.string().regex(REPO_RE, { error: "must be owner/name" }), {
      error: "must be a list of owner/name repositories",
    })
    .min(1, { error: "must list at least one repository" }),
});

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

const personSchema = z
  .object({
    name: z.string().nullish(),
    email: z.string().nullish(),
    date: z.string().nullish(),
  })
  .nullish();

const commitListSchema = z.array(
  z.object({
    author: z.object({ id: z.number(), login: z.string() }).nullish(),
    commit: z.object({ author: personSchema, committer: personSchema }),
  }),
);

const userSchema = z.object({ login: z.string() });

export class GitHubApiError extends Error {
  override name = "GitHubApiError";
}

interface GitHubLiveConfig {
  baseUrl: string;
  repositories: string[];
  token: string;
  tokenSource: string;
  requestTimeoutMs: number;
}

/**
 * Live GitHub adapter using the REST API (`GET /repos/{owner}/{repo}/commits`).
 *
 * - Rows are per (repository, author). Authors are keyed by GitHub account ID
 *   when the commit is linked to an account, otherwise by commit email.
 * - Commits are counted by committer date, which is the date GitHub filters on.
 * - The token is sent only to the configured API origin, including when
 *   following pagination links.
 */
export class GitHubLiveGitProvider implements GitProvider, HealthCheckable {
  readonly category = "git";
  readonly mode = "live";
  readonly type = "github";
  readonly #config: GitHubLiveConfig;
  readonly #base: URL;

  constructor(
    readonly id: string,
    readonly name: string,
    config: GitHubLiveConfig,
    private readonly fetchImpl: FetchLike,
  ) {
    this.#config = config;
    this.#base = new URL(config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
  }

  async getCommitStats(query: GitStatsQuery): Promise<GitCommitStats[]> {
    const repos = this.#config.repositories.filter(
      (repo) => query.repositories.length === 0 || query.repositories.includes(repo.toLowerCase()),
    );
    const rows: GitCommitStats[] = [];
    for (const repo of repos) {
      rows.push(...(await this.#repositoryStats(repo, query)));
    }
    return rows;
  }

  async healthCheck(signal: AbortSignal): Promise<HealthCheckResult> {
    const userResponse = await this.#request(this.#url("user"), signal);
    await this.#ensureOk(userResponse, "authenticating");
    const user = userSchema.safeParse(await userResponse.json());
    const login = user.success ? user.data.login : "unknown user";

    const inaccessible: string[] = [];
    for (const repo of this.#config.repositories) {
      const response = await this.#request(this.#url(`repos/${repo}`), signal);
      if (!response.ok) inaccessible.push(`${repo} (HTTP ${response.status})`);
      await response.body?.cancel();
    }
    const total = this.#config.repositories.length;
    if (inaccessible.length > 0) {
      return {
        ok: false,
        message: `Authenticated as ${login}; cannot access ${inaccessible.join(", ")}.`,
      };
    }
    return {
      ok: true,
      message: `Authenticated as ${login}; ${total}/${total} repositories accessible.`,
    };
  }

  async #repositoryStats(repo: string, query: GitStatsQuery): Promise<GitCommitStats[]> {
    const first = this.#url(`repos/${repo}/commits`);
    first.searchParams.set("since", query.period.since.toISOString());
    // GitHub's `until` is inclusive; the internal period end is exclusive.
    first.searchParams.set("until", new Date(query.period.until.getTime() - 1000).toISOString());
    first.searchParams.set("per_page", "100");

    const byAuthor = new Map<string, { author: ContributorRef; commits: number }>();
    let next: URL | undefined = first;
    let pages = 0;
    while (next) {
      pages += 1;
      if (pages > GITHUB_MAX_PAGES) {
        throw new GitHubApiError(
          `${repo} has more than ${GITHUB_MAX_PAGES * 100} commits in this period; narrow the reporting period.`,
        );
      }
      const response = await this.#request(next, query.signal);
      // 409: the repository is empty.
      if (response.status === 409) {
        await response.body?.cancel();
        return [];
      }
      await this.#ensureOk(response, `listing commits for ${repo}`, repo);
      const parsed = commitListSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new GitHubApiError(
          `Unexpected response from GitHub while listing commits for ${repo}.`,
        );
      }
      for (const item of parsed.data) {
        const committedAt = item.commit.committer?.date ?? item.commit.author?.date;
        if (committedAt && !isWithinPeriod(new Date(committedAt), query.period)) continue;
        const email = item.commit.author?.email ?? undefined;
        const author: ContributorRef = {
          displayName: item.commit.author?.name || item.author?.login || "Unknown author",
          email,
          username: item.author?.login,
          providerUserId: item.author ? String(item.author.id) : undefined,
        };
        const key = item.author
          ? `id:${item.author.id}`
          : `email:${normalizeEmail(email) ?? `name:${author.displayName}`}`;
        const entry = byAuthor.get(key);
        if (entry) entry.commits += 1;
        else byAuthor.set(key, { author, commits: 1 });
      }
      next = this.#nextLink(response.headers.get("link"));
    }
    return [...byAuthor.values()].map(({ author, commits }) => ({
      repository: repo,
      author,
      commits,
    }));
  }

  #url(path: string): URL {
    return new URL(path, this.#base);
  }

  #nextLink(header: string | null): URL | undefined {
    if (!header) return undefined;
    for (const part of header.split(",")) {
      const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
      if (!match?.[1]) continue;
      const url = new URL(match[1]);
      if (url.origin !== this.#base.origin) {
        throw new GitHubApiError(
          "GitHub returned a pagination link to a different host; refusing to follow it.",
        );
      }
      return url;
    }
    return undefined;
  }

  async #request(url: URL, signal: AbortSignal | undefined): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#config.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#config.token}`,
          "User-Agent": "devzy",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: combined,
      });
    } catch (error) {
      if (timeout.aborted) {
        throw new GitHubApiError(
          `GitHub request timed out after ${this.#config.requestTimeoutMs} ms.`,
        );
      }
      if (signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new GitHubApiError(`Could not reach GitHub at ${this.#base.origin}: ${reason}`);
    }
  }

  async #ensureOk(response: Response, action: string, repo?: string): Promise<void> {
    if (response.ok) return;
    // The body is never echoed: it is not needed and could contain request details.
    await response.body?.cancel();
    const status = response.status;
    if (status === 401) {
      throw new GitHubApiError(
        `GitHub rejected the credentials while ${action} (HTTP 401). Check the token in ${this.#config.tokenSource}.`,
      );
    }
    if (
      (status === 403 || status === 429) &&
      response.headers.get("x-ratelimit-remaining") === "0"
    ) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const when =
        Number.isFinite(reset) && reset > 0
          ? ` (resets ${new Date(reset * 1000).toISOString()})`
          : "";
      throw new GitHubApiError(`GitHub API rate limit exceeded while ${action}${when}.`);
    }
    if (status === 403) {
      throw new GitHubApiError(
        `GitHub denied access while ${action} (HTTP 403). Check the token's permissions.`,
      );
    }
    if (status === 404 && repo) {
      throw new GitHubApiError(
        `Repository ${repo} was not found or the token cannot access it (HTTP 404).`,
      );
    }
    throw new GitHubApiError(`GitHub request failed while ${action} (HTTP ${status}).`);
  }
}

export const githubLiveAdapter: AdapterDefinition = {
  mode: "live",
  optionsSchema: githubLiveOptionsSchema,
  credential: {
    defaultEnv: "GITHUB_TOKEN",
    description: "GitHub token with read access to the repositories (classic or fine-grained).",
  },
  setupFields: [
    {
      key: "repositories",
      flag: "repo",
      label: "Repositories (owner/name, comma-separated)",
      kind: "list",
      required: true,
    },
    {
      key: "baseUrl",
      flag: "base-url",
      label: "API base URL",
      kind: "url",
      required: false,
      default: GITHUB_DEFAULT_BASE_URL,
    },
  ],
  create(ctx: AdapterContext) {
    const options = githubLiveOptionsSchema.parse(ctx.options);
    if (!ctx.token) throw new GitHubApiError("No GitHub token is configured.");
    return new GitHubLiveGitProvider(
      ctx.id,
      ctx.name,
      {
        baseUrl: options.baseUrl,
        repositories: options.repositories,
        token: ctx.token,
        tokenSource: ctx.tokenSource ?? "the configured credential",
        requestTimeoutMs: ctx.settings.requestTimeoutMs,
      },
      ctx.fetch,
    );
  },
};

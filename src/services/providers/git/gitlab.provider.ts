import { z } from "zod";
import type { GitCommitStats } from "../../../domain/git.ts";
import { type ContributorRef, normalizeEmail } from "../../../domain/identity.ts";
import { isWithinPeriod } from "../../../domain/period.ts";
import type { AdapterContext, AdapterDefinition, FetchLike } from "../adapter.ts";
import type { HealthCheckable, HealthCheckResult } from "../base.interface.ts";
import {
  apiBase,
  HttpClient,
  httpUrlSchema,
  nextLink,
  ProviderHttpError,
  parseTimestamp,
  type Sleep,
} from "../http.ts";
import type { GitProvider, GitStatsQuery } from "./git.interface.ts";

const PROJECT_PATH_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
export const GITLAB_DEFAULT_BASE_URL = "https://gitlab.com";
/** 100 commits per page; more than this per project and period is rejected rather than truncated. */
export const GITLAB_MAX_PAGES = 50;
const PER_PAGE = 100;

export const gitlabLiveOptionsSchema = z.strictObject({
  /** Instance root (not the API root); `/api/v4` is appended. Sub-path installs are supported. */
  baseUrl: httpUrlSchema.default(GITLAB_DEFAULT_BASE_URL),
  /** Full project paths, e.g. `group/project` or `group/subgroup/project`. */
  projects: z
    .array(
      z
        .string()
        .regex(PROJECT_PATH_RE, { error: "must be a full project path such as group/project" }),
      {
        error: "must be a list of project paths",
      },
    )
    .min(1, { error: "must list at least one project" }),
});

const personSchema = z.object({
  author_name: z.string().nullish(),
  author_email: z.string().nullish(),
  authored_date: z.string().nullish(),
  committed_date: z.string().nullish(),
});
const commitListSchema = z.array(personSchema);
const projectSchema = z.object({
  path_with_namespace: z.string(),
  empty_repo: z.boolean().nullish(),
});
const userSchema = z.object({ username: z.string() });

interface GitLabLiveConfig {
  baseUrl: string;
  projects: string[];
  token: string;
  tokenSource: string;
  requestTimeoutMs: number;
  sleep?: Sleep | undefined;
}

/**
 * Live GitLab adapter (REST API v4, `GET /projects/:id/repository/commits`).
 *
 * - Default branch only, like the GitHub adapter.
 * - Rows are per (project, author). GitLab commits carry no user account ID,
 *   so authors are keyed by normalized email (falling back to name).
 * - Commits are counted by `committed_date` inside the half-open period.
 * - An empty repository, or a project without a default branch, yields no rows.
 */
export class GitLabLiveGitProvider implements GitProvider, HealthCheckable {
  readonly category = "git";
  readonly mode = "live";
  readonly type = "gitlab";
  readonly #http: HttpClient;
  readonly #projects: string[];

  constructor(
    readonly id: string,
    readonly name: string,
    config: GitLabLiveConfig,
    fetchImpl: FetchLike,
  ) {
    this.#projects = config.projects;
    this.#http = new HttpClient({
      label: "GitLab",
      base: apiBase(config.baseUrl, "api/v4"),
      headers: { "PRIVATE-TOKEN": config.token, Accept: "application/json" },
      timeoutMs: config.requestTimeoutMs,
      fetch: fetchImpl,
      sleep: config.sleep,
      credentialHint: config.tokenSource,
    });
  }

  async getCommitStats(query: GitStatsQuery): Promise<GitCommitStats[]> {
    const projects = this.#projects.filter(
      (p) => query.repositories.length === 0 || query.repositories.includes(p.toLowerCase()),
    );
    const rows: GitCommitStats[] = [];
    for (const project of projects) rows.push(...(await this.#projectStats(project, query)));
    return rows;
  }

  async healthCheck(signal: AbortSignal): Promise<HealthCheckResult> {
    const { data: user } = await this.#http.getJson(this.#http.url("user"), userSchema, {
      action: "authenticating",
      signal,
    });
    const inaccessible: string[] = [];
    for (const project of this.#projects) {
      const response = await this.#http.request(this.#projectUrl(project), {
        action: "checking project access",
        signal,
      });
      if (!response.ok) inaccessible.push(`${project} (HTTP ${response.status})`);
      await response.body?.cancel();
    }
    const total = this.#projects.length;
    if (inaccessible.length > 0) {
      return {
        ok: false,
        message: `Authenticated as ${user.username}; cannot access ${inaccessible.join(", ")}.`,
      };
    }
    return {
      ok: true,
      message: `Authenticated as ${user.username}; ${total}/${total} projects accessible.`,
    };
  }

  #projectUrl(project: string): URL {
    return this.#http.url(`projects/${encodeURIComponent(project)}`);
  }

  async #projectStats(project: string, query: GitStatsQuery): Promise<GitCommitStats[]> {
    const action = `listing commits for ${project}`;
    const context = { action, resource: `project ${project}`, signal: query.signal };
    const first = this.#http.url(`projects/${encodeURIComponent(project)}/repository/commits`);
    first.searchParams.set("since", query.period.since.toISOString());
    // GitLab's `until` is inclusive; the internal period end is exclusive.
    first.searchParams.set("until", new Date(query.period.until.getTime() - 1000).toISOString());
    first.searchParams.set("per_page", String(PER_PAGE));
    first.searchParams.set("page", "1");

    const byAuthor = new Map<string, { author: ContributorRef; commits: number }>();
    let next: URL | undefined = first;
    let pages = 0;
    while (next) {
      pages += 1;
      if (pages > GITLAB_MAX_PAGES) {
        throw new ProviderHttpError(
          `${project} has more than ${GITLAB_MAX_PAGES * PER_PAGE} commits in this period; narrow the reporting period.`,
          "client",
        );
      }
      const response = await this.#http.request(next, context);
      if (response.status === 404) {
        await response.body?.cancel();
        // 404 is also returned when the repository is empty or has no default
        // branch; confirm the project itself is accessible (throws if not).
        await this.#http.getJson(this.#projectUrl(project), projectSchema, context);
        return [];
      }
      await this.#http.ensureOk(response, context);
      const commits = await this.#http.parseJson(response, commitListSchema, context);
      for (const commit of commits) {
        const committedAt = parseTimestamp(commit.committed_date ?? commit.authored_date);
        if (committedAt && !isWithinPeriod(committedAt, query.period)) continue;
        const email = commit.author_email ?? undefined;
        const displayName = commit.author_name || email || "Unknown author";
        const key = normalizeEmail(email) ?? `name:${displayName}`;
        const entry = byAuthor.get(key);
        if (entry) entry.commits += 1;
        else byAuthor.set(key, { author: { displayName, email }, commits: 1 });
      }
      next = this.#nextPage(response, next, commits.length);
    }
    return [...byAuthor.values()].map(({ author, commits }) => ({
      repository: project,
      author,
      commits,
    }));
  }

  #nextPage(response: Response, current: URL, received: number): URL | undefined {
    const link = nextLink(response.headers.get("link"));
    if (link) return this.#http.assertSameOrigin(link);
    const nextPage = response.headers.get("x-next-page")?.trim();
    if (nextPage) {
      const url = new URL(current);
      url.searchParams.set("page", nextPage);
      return url;
    }
    // Headers absent (e.g. behind a proxy): continue only after a full page.
    if (response.headers.get("x-page") === null && received === PER_PAGE) {
      const url = new URL(current);
      url.searchParams.set("page", String(Number(current.searchParams.get("page") ?? "1") + 1));
      return url;
    }
    return undefined;
  }
}

export const gitlabLiveAdapter: AdapterDefinition = {
  mode: "live",
  optionsSchema: gitlabLiveOptionsSchema,
  credential: {
    defaultEnv: "GITLAB_TOKEN",
    description: "GitLab personal, project or group access token with the read_api scope.",
  },
  setupFields: [
    {
      key: "projects",
      flag: "project",
      label: "Projects (full paths, comma-separated)",
      kind: "list",
      required: true,
    },
    {
      key: "baseUrl",
      flag: "base-url",
      label: "GitLab URL",
      kind: "url",
      required: false,
      default: GITLAB_DEFAULT_BASE_URL,
    },
  ],
  create(ctx: AdapterContext) {
    const options = gitlabLiveOptionsSchema.parse(ctx.options);
    if (!ctx.token) throw new ProviderHttpError("No GitLab token is configured.", "auth");
    return new GitLabLiveGitProvider(
      ctx.id,
      ctx.name,
      {
        baseUrl: options.baseUrl,
        projects: options.projects,
        token: ctx.token,
        tokenSource: ctx.tokenSource ?? "the configured credential",
        requestTimeoutMs: ctx.settings.requestTimeoutMs,
      },
      ctx.fetch,
    );
  },
};

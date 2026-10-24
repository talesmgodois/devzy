import { z } from "zod";
import { isPlausibleEmail } from "../../../domain/identity.ts";
import { addDays, formatCalendarDate, isWithinPeriod } from "../../../domain/period.ts";
import {
  mergeStatusMaps,
  type StatusMapping,
  summarizeTaskEvents,
  type TaskStatsResult,
  type VendorTaskEvent,
} from "../../../domain/tasks.ts";
import type { AdapterContext, AdapterDefinition, FetchLike } from "../adapter.ts";
import type { HealthCheckable, HealthCheckResult } from "../base.interface.ts";
import {
  apiBase,
  basicAuth,
  HttpClient,
  httpUrlSchema,
  ProviderHttpError,
  parseTimestamp,
  type Sleep,
} from "../http.ts";
import { JIRA_STATUS_MAP, statusMapSchema } from "./status-maps.ts";
import type { TaskProvider, TaskStatsQuery } from "./task.interface.ts";

const PROJECT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;
/** 50 issues per page (each carries its changelog); more is rejected rather than truncated. */
export const JIRA_MAX_PAGES = 200;
const PAGE_SIZE = 50;
const FIELDS = ["assignee", "status", "statuscategorychangedate", "updated", "created"];

export const jiraLiveOptionsSchema = z.strictObject({
  /** Site root, e.g. https://your-site.atlassian.net */
  baseUrl: httpUrlSchema,
  /** Atlassian account email used for Basic authentication (not a secret). */
  email: z.string().refine(isPlausibleEmail, { error: "must be an email address" }),
  /** Project keys, e.g. ["ENG", "OPS"]. */
  projects: z
    .array(z.string().regex(PROJECT_KEY_RE, { error: "must be a Jira project key such as ENG" }), {
      error: "must be a list of project keys",
    })
    .min(1, { error: "must list at least one project key" }),
  /** Optional extra JQL clause, combined with AND. */
  jql: z.string().trim().min(1, { error: "must not be empty" }).optional(),
  /** Vendor status → bucket overrides, merged over the defaults. */
  statusMap: statusMapSchema.optional(),
});

const issueSchema = z.object({
  fields: z.object({
    assignee: z
      .object({
        accountId: z.string(),
        displayName: z.string().nullish(),
        emailAddress: z.string().nullish(),
      })
      .nullish(),
    status: z.object({ name: z.string() }).nullish(),
    statuscategorychangedate: z.string().nullish(),
    updated: z.string().nullish(),
    created: z.string().nullish(),
  }),
  changelog: z
    .object({
      total: z.number().nullish(),
      histories: z.array(
        z.object({
          created: z.string(),
          items: z.array(z.object({ field: z.string().nullish(), fieldId: z.string().nullish() })),
        }),
      ),
    })
    .nullish(),
});

type JiraIssue = z.output<typeof issueSchema>;

/**
 * When the issue's status last changed, from the changelog returned by the
 * search (`expand=changelog`, newest entries first, possibly truncated):
 *
 * 1. the newest history entry that changes `status`: exact;
 * 2. a complete changelog with no status change: the issue still has the
 *    status it was created with, so `created`;
 * 3. a truncated changelog without a status change: the change is older than
 *    the oldest returned entry, which is returned as an upper bound when it
 *    precedes `periodStart` (so the issue is correctly excluded);
 * 4. otherwise (no changelog, or 40+ newer non-status edits inside the
 *    period): `statuscategorychangedate`, then `updated`.
 */
export function lastStatusChange(issue: JiraIssue, periodStart: Date): Date | undefined {
  const { fields, changelog } = issue;
  const fallback = () =>
    parseTimestamp(fields.statuscategorychangedate) ?? parseTimestamp(fields.updated);
  if (!changelog) return fallback();
  let newestStatusChange: Date | undefined;
  let oldestEntry: Date | undefined;
  for (const history of changelog.histories) {
    const at = parseTimestamp(history.created);
    if (!at) continue;
    if (!oldestEntry || at < oldestEntry) oldestEntry = at;
    const changesStatus = history.items.some(
      (item) => item.fieldId === "status" || item.field === "status",
    );
    if (changesStatus && (!newestStatusChange || at > newestStatusChange)) newestStatusChange = at;
  }
  if (newestStatusChange) return newestStatusChange;
  const complete = (changelog.total ?? changelog.histories.length) <= changelog.histories.length;
  if (complete) return parseTimestamp(fields.created) ?? fallback();
  if (oldestEntry && oldestEntry < periodStart) return oldestEntry;
  return fallback();
}
const searchSchema = z.object({
  issues: z.array(issueSchema),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
});
const myselfSchema = z.object({ accountId: z.string(), displayName: z.string().nullish() });

interface JiraLiveConfig {
  baseUrl: string;
  email: string;
  projects: string[];
  jql: string | undefined;
  statusMap: StatusMapping;
  token: string;
  tokenSource: string;
  requestTimeoutMs: number;
  sleep?: Sleep | undefined;
}

function quoteJql(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Live Jira Cloud adapter (REST API v3, enhanced search `GET /rest/api/3/search/jql`).
 *
 * A task counts when its status last changed inside the period, bucketed by
 * its current status. The change time comes from the changelog embedded in
 * the search results (`expand=changelog`), so transitions within one status
 * category (e.g. In Progress → In Code Review) count too; no per-issue
 * requests are made. See {@link lastStatusChange}. Unassigned issues are
 * excluded and reported.
 */
export class JiraLiveTaskProvider implements TaskProvider, HealthCheckable {
  readonly category = "tasks";
  readonly mode = "live";
  readonly type = "jira";
  readonly #http: HttpClient;
  readonly #config: JiraLiveConfig;

  constructor(
    readonly id: string,
    readonly name: string,
    config: JiraLiveConfig,
    fetchImpl: FetchLike,
  ) {
    this.#config = config;
    this.#http = new HttpClient({
      label: "Jira",
      base: apiBase(config.baseUrl, "rest/api/3"),
      headers: { Authorization: basicAuth(config.email, config.token), Accept: "application/json" },
      timeoutMs: config.requestTimeoutMs,
      fetch: fetchImpl,
      sleep: config.sleep,
      credentialHint: config.tokenSource,
    });
  }

  /**
   * JQL is evaluated in the Jira user's timezone, so the date bounds are
   * widened by a day and the exact half-open period is re-checked locally.
   * A status change in the period implies `updated` >= period start and
   * `created` < period end.
   */
  buildJql(query: TaskStatsQuery): string {
    const projects = this.#config.projects.map(quoteJql).join(", ");
    const from = formatCalendarDate(addDays(query.period.since, -1));
    const to = formatCalendarDate(addDays(query.period.until, 1));
    const extra = this.#config.jql ? ` AND (${this.#config.jql})` : "";
    return `project in (${projects}) AND updated >= "${from}" AND created < "${to}"${extra} ORDER BY key ASC`;
  }

  async getUserTaskStats(query: TaskStatsQuery): Promise<TaskStatsResult> {
    const context = {
      action: "searching issues",
      resource: "the configured projects",
      signal: query.signal,
    };
    const events: VendorTaskEvent[] = [];
    let unassigned = 0;
    let token: string | undefined;
    const seenTokens = new Set<string>();
    for (let page = 1; ; page++) {
      if (page > JIRA_MAX_PAGES) {
        throw new ProviderHttpError(
          `More than ${JIRA_MAX_PAGES * PAGE_SIZE} Jira issues match this period; narrow the period or add options.jql.`,
          "client",
        );
      }
      const url = this.#http.url("search/jql");
      url.searchParams.set("jql", this.buildJql(query));
      url.searchParams.set("fields", FIELDS.join(","));
      url.searchParams.set("expand", "changelog");
      url.searchParams.set("maxResults", String(PAGE_SIZE));
      if (token) url.searchParams.set("nextPageToken", token);
      const { data } = await this.#http.getJson(url, searchSchema, context);

      for (const issue of data.issues) {
        const { fields } = issue;
        const changedAt = lastStatusChange(issue, query.period.since);
        if (!changedAt || !isWithinPeriod(changedAt, query.period)) continue;
        if (!fields.assignee) {
          unassigned += 1;
          continue;
        }
        events.push({
          assignee: {
            displayName: fields.assignee.displayName || fields.assignee.accountId,
            email: fields.assignee.emailAddress || undefined,
            providerUserId: fields.assignee.accountId,
          },
          assigneeKey: fields.assignee.accountId,
          status: fields.status?.name ?? "(no status)",
        });
      }

      token = data.nextPageToken ?? undefined;
      if (!token || data.isLast === true) break;
      if (seenTokens.has(token)) {
        throw new ProviderHttpError(
          "Jira returned a repeated page token; stopping to avoid a loop.",
          "invalid_response",
        );
      }
      seenTokens.add(token);
    }
    return {
      ...summarizeTaskEvents(events, this.#config.statusMap),
      excluded: [{ reason: "without an assignee", count: unassigned }],
    };
  }

  async healthCheck(signal: AbortSignal): Promise<HealthCheckResult> {
    const { data: me } = await this.#http.getJson(this.#http.url("myself"), myselfSchema, {
      action: "authenticating",
      signal,
    });
    const inaccessible: string[] = [];
    for (const key of this.#config.projects) {
      const response = await this.#http.request(
        this.#http.url(`project/${encodeURIComponent(key)}`),
        {
          action: "checking project access",
          signal,
        },
      );
      if (!response.ok) inaccessible.push(`${key} (HTTP ${response.status})`);
      await response.body?.cancel();
    }
    const who = me.displayName ?? me.accountId;
    const total = this.#config.projects.length;
    if (inaccessible.length > 0) {
      return {
        ok: false,
        message: `Authenticated as ${who}; cannot access ${inaccessible.join(", ")}.`,
      };
    }
    return { ok: true, message: `Authenticated as ${who}; ${total}/${total} projects accessible.` };
  }
}

export const jiraLiveAdapter: AdapterDefinition = {
  mode: "live",
  optionsSchema: jiraLiveOptionsSchema,
  credential: {
    defaultEnv: "JIRA_API_TOKEN",
    description: "Atlassian API token for the account email (needs Browse projects)",
  },
  setupFields: [
    {
      key: "baseUrl",
      flag: "base-url",
      label: "Jira site URL (https://your-site.atlassian.net)",
      kind: "url",
      required: true,
    },
    {
      key: "email",
      flag: "account-email",
      label: "Atlassian account email",
      kind: "string",
      required: true,
    },
    {
      key: "projects",
      flag: "project",
      label: "Project keys (comma-separated)",
      kind: "list",
      required: true,
    },
  ],
  create(ctx: AdapterContext) {
    const options = jiraLiveOptionsSchema.parse(ctx.options);
    if (!ctx.token) throw new ProviderHttpError("No Jira API token is configured.", "auth");
    return new JiraLiveTaskProvider(
      ctx.id,
      ctx.name,
      {
        baseUrl: options.baseUrl,
        email: options.email.trim(),
        projects: options.projects,
        jql: options.jql,
        statusMap: mergeStatusMaps(JIRA_STATUS_MAP, options.statusMap),
        token: ctx.token,
        tokenSource: ctx.tokenSource ?? "the configured credential",
        requestTimeoutMs: ctx.settings.requestTimeoutMs,
      },
      ctx.fetch,
    );
  },
};

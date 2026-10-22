import { z } from "zod";
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
import { OPENPROJECT_STATUS_MAP, statusMapSchema } from "./status-maps.ts";
import type { TaskProvider, TaskStatsQuery } from "./task.interface.ts";

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Work packages per page requested; the server may cap it lower. */
const PAGE_SIZE = 100;
/** More pages than this per project is rejected rather than truncated. */
export const OPENPROJECT_MAX_PAGES = 100;

export const openprojectLiveOptionsSchema = z.strictObject({
  /** Instance root; `/api/v3` is appended. */
  baseUrl: httpUrlSchema,
  /** Project identifiers (e.g. "website") or numeric IDs. */
  projects: z
    .array(z.string().regex(PROJECT_RE, { error: "must be a project identifier or numeric ID" }), {
      error: "must be a list of project identifiers",
    })
    .min(1, { error: "must list at least one project" }),
  /** Vendor status → bucket overrides, merged over the defaults. */
  statusMap: statusMapSchema.optional(),
});

const linkSchema = z.object({ href: z.string().nullish(), title: z.string().nullish() });
const workPackageSchema = z.object({
  id: z.number(),
  updatedAt: z.string().nullish(),
  _links: z.object({ status: linkSchema.nullish(), assignee: linkSchema.nullish() }),
});
const collectionSchema = z.object({
  total: z.number(),
  pageSize: z.number().nullish(),
  _embedded: z.object({ elements: z.array(workPackageSchema) }),
});
const meSchema = z.object({
  name: z.string().nullish(),
  login: z.string().nullish(),
  id: z.number(),
});

interface OpenProjectLiveConfig {
  baseUrl: string;
  projects: string[];
  statusMap: StatusMapping;
  token: string;
  tokenSource: string;
  requestTimeoutMs: number;
  sleep?: Sleep | undefined;
}

type AssigneeKind = "user" | "group" | "placeholder" | "none";

/** Classifies a HAL assignee link: `/api/v3/users/42`, `/groups/5`, `/placeholder_users/3` or none. */
export function classifyAssignee(href: string | null | undefined): {
  kind: AssigneeKind;
  id?: string;
} {
  if (!href) return { kind: "none" };
  const match = /\/(users|groups|placeholder_users)\/(\d+)\/?$/.exec(href);
  if (!match?.[2]) return { kind: "none" };
  const kind = match[1] === "users" ? "user" : match[1] === "groups" ? "group" : "placeholder";
  return { kind, id: match[2] };
}

/**
 * Live OpenProject adapter (API v3, `GET /api/v3/projects/{id}/work_packages`).
 *
 * OpenProject exposes no "status changed at" timestamp on work packages, so
 * `updatedAt` is used as the approximation: a work package counts when it was
 * last updated inside the period, bucketed by its current status. Unassigned
 * work packages and those assigned to groups or placeholder users are
 * excluded and reported.
 */
export class OpenProjectLiveTaskProvider implements TaskProvider, HealthCheckable {
  readonly category = "tasks";
  readonly mode = "live";
  readonly type = "openproject";
  readonly #http: HttpClient;
  readonly #config: OpenProjectLiveConfig;

  constructor(
    readonly id: string,
    readonly name: string,
    config: OpenProjectLiveConfig,
    fetchImpl: FetchLike,
  ) {
    this.#config = config;
    this.#http = new HttpClient({
      label: "OpenProject",
      base: apiBase(config.baseUrl, "api/v3"),
      headers: { Authorization: basicAuth("apikey", config.token), Accept: "application/hal+json" },
      timeoutMs: config.requestTimeoutMs,
      fetch: fetchImpl,
      sleep: config.sleep,
      credentialHint: config.tokenSource,
    });
  }

  async getUserTaskStats(query: TaskStatsQuery): Promise<TaskStatsResult> {
    const events: VendorTaskEvent[] = [];
    let unassigned = 0;
    let nonUser = 0;
    for (const project of this.#config.projects) {
      for (const wp of await this.#workPackages(project, query)) {
        const updatedAt = parseTimestamp(wp.updatedAt);
        if (!updatedAt || !isWithinPeriod(updatedAt, query.period)) continue;
        const assignee = classifyAssignee(wp._links.assignee?.href);
        if (assignee.kind === "none" || assignee.id === undefined) {
          unassigned += 1;
          continue;
        }
        if (assignee.kind !== "user") {
          nonUser += 1;
          continue;
        }
        events.push({
          assignee: {
            displayName: wp._links.assignee?.title || `User ${assignee.id}`,
            providerUserId: assignee.id,
          },
          assigneeKey: assignee.id,
          status: wp._links.status?.title ?? "(no status)",
        });
      }
    }
    return {
      ...summarizeTaskEvents(events, this.#config.statusMap),
      excluded: [
        { reason: "without an assignee", count: unassigned },
        { reason: "assigned to a group or placeholder user", count: nonUser },
      ],
    };
  }

  /**
   * Fetches work packages updated in the period (widened by a day on each
   * side for timezone safety; the exact period is re-checked by the caller).
   * Passing `filters` replaces OpenProject's default "open only" filter, so
   * closed work packages are included.
   */
  async #workPackages(
    project: string,
    query: TaskStatsQuery,
  ): Promise<z.output<typeof workPackageSchema>[]> {
    const context = {
      action: `listing work packages for ${project}`,
      resource: `project ${project}`,
      signal: query.signal,
    };
    const filters = JSON.stringify([
      {
        updatedAt: {
          operator: "<>d",
          values: [
            formatCalendarDate(addDays(query.period.since, -1)),
            formatCalendarDate(query.period.until),
          ],
        },
      },
    ]);
    const out: z.output<typeof workPackageSchema>[] = [];
    for (let page = 1; ; page++) {
      if (page > OPENPROJECT_MAX_PAGES) {
        throw new ProviderHttpError(
          `${project} has more than ${OPENPROJECT_MAX_PAGES} pages of work packages in this period; narrow the reporting period.`,
          "client",
        );
      }
      const url = this.#http.url(`projects/${encodeURIComponent(project)}/work_packages`);
      url.searchParams.set("filters", filters);
      url.searchParams.set("pageSize", String(PAGE_SIZE));
      url.searchParams.set("offset", String(page)); // a page number in OpenProject, starting at 1
      url.searchParams.set("sortBy", JSON.stringify([["id", "asc"]]));
      const { data } = await this.#http.getJson(url, collectionSchema, context);
      const elements = data._embedded.elements;
      out.push(...elements);
      const effectivePageSize = data.pageSize ?? PAGE_SIZE;
      if (elements.length === 0 || page * effectivePageSize >= data.total) break;
    }
    return out;
  }

  async healthCheck(signal: AbortSignal): Promise<HealthCheckResult> {
    const { data: me } = await this.#http.getJson(this.#http.url("users/me"), meSchema, {
      action: "authenticating",
      signal,
    });
    const inaccessible: string[] = [];
    for (const project of this.#config.projects) {
      const response = await this.#http.request(
        this.#http.url(`projects/${encodeURIComponent(project)}`),
        {
          action: "checking project access",
          signal,
        },
      );
      if (!response.ok) inaccessible.push(`${project} (HTTP ${response.status})`);
      await response.body?.cancel();
    }
    const who = me.login ?? me.name ?? `user ${me.id}`;
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

export const openprojectLiveAdapter: AdapterDefinition = {
  mode: "live",
  optionsSchema: openprojectLiveOptionsSchema,
  credential: {
    defaultEnv: "OPENPROJECT_API_KEY",
    description: "OpenProject API token (My account > Access tokens) with View work packages",
  },
  setupFields: [
    { key: "baseUrl", flag: "base-url", label: "OpenProject URL", kind: "url", required: true },
    {
      key: "projects",
      flag: "project",
      label: "Project identifiers (comma-separated)",
      kind: "list",
      required: true,
    },
  ],
  create(ctx: AdapterContext) {
    const options = openprojectLiveOptionsSchema.parse(ctx.options);
    if (!ctx.token) throw new ProviderHttpError("No OpenProject API token is configured.", "auth");
    return new OpenProjectLiveTaskProvider(
      ctx.id,
      ctx.name,
      {
        baseUrl: options.baseUrl,
        projects: options.projects,
        statusMap: mergeStatusMaps(OPENPROJECT_STATUS_MAP, options.statusMap),
        token: ctx.token,
        tokenSource: ctx.tokenSource ?? "the configured credential",
        requestTimeoutMs: ctx.settings.requestTimeoutMs,
      },
      ctx.fetch,
    );
  },
};

import type {
  ActivityReport,
  CombinedReportRow,
  ContributorSummary,
  GitReportRow,
  ProviderFailure,
  ReportSource,
  SortKey,
  TaskReportRow,
} from "../domain/activity.ts";
import type { ReportKind, ReportQuery } from "../domain/filters.ts";
import type { GitCommitStats } from "../domain/git.ts";
import type { ContributorRef } from "../domain/identity.ts";
import {
  emptyTaskCounts,
  TASK_STATUSES,
  type TaskCounts,
  type TaskStatsResult,
} from "../domain/tasks.ts";
import { errorMessage, UsageError } from "../lib/errors.ts";
import type { DevzyConfig, ProviderEntry } from "./config/schema.ts";
import {
  applyStatusFilter,
  emailFilterOutcome,
  matchesRepository,
  selectProviders,
} from "./filtering.ts";
import { IdentityResolver, type ResolvedIdentity } from "./identity-resolver.ts";
import type { FetchLike, Provider } from "./providers/adapter.ts";
import type { GitProvider } from "./providers/git/git.interface.ts";
import type { ProviderRegistry, ResolvedCredential } from "./providers/registry.ts";
import type { TaskProvider } from "./providers/tasks/task.interface.ts";
import { rankCombinedRows, rankGitRows, rankTaskRows } from "./ranking.ts";

/** Everything needed to build providers from configuration. */
export interface ProviderRuntime {
  registry: ProviderRegistry;
  config: DevzyConfig;
  credentials: ReadonlyMap<string, ResolvedCredential>;
  fetch: FetchLike;
}

export interface ReportOptions {
  sortKey: SortKey;
  /** Allow mock and live providers in the same report (each source is labelled). */
  allowMixedModes?: boolean;
}

type Outcome<T> = { source: ReportSource } & (
  | { ok: true; data: T }
  | { ok: false; message: string }
);

/** Attributed row before grouping. */
interface Attributed {
  providerId: string;
  identity: ResolvedIdentity;
  ref: ContributorRef;
}

/**
 * Provider-independent aggregation of Git and task activity.
 *
 * Failure policy: providers are queried concurrently; a failure is captured per
 * provider and reported in `failures` (never as zero activity) while other
 * providers' results are still aggregated.
 */
export class ActivityService {
  constructor(private readonly runtime: ProviderRuntime) {}

  /** Providers a report would query, after filter validation. */
  selectSources(
    query: ReportQuery,
    options: Pick<ReportOptions, "allowMixedModes">,
  ): ProviderEntry[] {
    const entries = selectProviders(this.runtime.config.providers, query.filters, query.kind);
    const modes = new Set(entries.map((e) => e.mode));
    if (modes.size > 1 && !options.allowMixedModes) {
      const listing = entries.map((e) => `${e.id} (${e.mode})`).join(", ");
      throw new UsageError(
        `The selected providers mix mock and live data: ${listing}.`,
        "Use --provider to select providers of one mode, or pass --allow-mixed-modes to combine them with each source labelled.",
      );
    }
    return entries;
  }

  async gitReport(query: ReportQuery, options: ReportOptions): Promise<ActivityReport<"git">> {
    const entries = this.selectSources(query, options);
    const outcomes = await this.#collectGit(entries, query);
    const notes = new NoteCollector();
    const rows = this.#buildGitRows(
      outcomes,
      query,
      notes,
      new IdentityResolver(this.runtime.config.identities),
    );
    return this.#report(
      "git",
      query,
      options.sortKey,
      outcomes,
      rankGitRows(rows, options.sortKey),
      notes,
    );
  }

  async taskReport(query: ReportQuery, options: ReportOptions): Promise<ActivityReport<"tasks">> {
    const entries = this.selectSources(query, options);
    const outcomes = await this.#collectTasks(entries, query);
    const notes = new NoteCollector();
    const rows = this.#buildTaskRows(
      outcomes,
      query,
      notes,
      new IdentityResolver(this.runtime.config.identities),
    );
    return this.#report(
      "tasks",
      query,
      options.sortKey,
      outcomes,
      rankTaskRows(rows, options.sortKey),
      notes,
    );
  }

  async combinedReport(query: ReportQuery, options: ReportOptions): Promise<ActivityReport<"all">> {
    const entries = this.selectSources(query, options);
    const [gitOutcomes, taskOutcomes] = await Promise.all([
      this.#collectGit(entries, query),
      this.#collectTasks(entries, query),
    ]);
    const notes = new NoteCollector();
    for (const category of ["git", "tasks"] as const) {
      if (!entries.some((e) => this.runtime.registry.categoryOf(e) === category)) {
        notes.add(
          `No ${category} providers are selected, so ${category === "git" ? "Commits" : "task"} columns show "-".`,
        );
      }
    }
    // One resolver for both categories so keys are shared across them.
    const resolver = new IdentityResolver(this.runtime.config.identities);
    const gitRows = this.#buildGitRows(gitOutcomes, query, notes, resolver);
    const taskRows = this.#buildTaskRows(taskOutcomes, query, notes, resolver);

    const combined = new Map<string, CombinedReportRow>();
    const upsert = (row: GitReportRow | TaskReportRow): CombinedReportRow => {
      let entry = combined.get(row.key);
      if (!entry) {
        entry = {
          key: row.key,
          displayName: row.displayName,
          identity: row.identity,
          memberId: row.memberId,
          providers: [],
          commits: undefined,
          tasks: undefined,
        };
        combined.set(row.key, entry);
      }
      entry.providers = [...new Set([...entry.providers, ...row.providers])].sort();
      return entry;
    };
    for (const row of gitRows) upsert(row).commits = row.commits;
    for (const row of taskRows) upsert(row).tasks = row.counts;

    const outcomes = [...gitOutcomes, ...taskOutcomes].sort(
      (a, b) =>
        entries.findIndex((e) => e.id === a.source.id) -
        entries.findIndex((e) => e.id === b.source.id),
    );
    return this.#report(
      "all",
      query,
      options.sortKey,
      outcomes,
      rankCombinedRows([...combined.values()], options.sortKey),
      notes,
    );
  }

  async #collectGit(
    entries: ProviderEntry[],
    query: ReportQuery,
  ): Promise<Outcome<GitCommitStats[]>[]> {
    return this.#collect(entries, "git", (p) =>
      (p as GitProvider).getCommitStats({
        period: query.period.period,
        repositories: query.filters.repositories,
      }),
    );
  }

  async #collectTasks(
    entries: ProviderEntry[],
    query: ReportQuery,
  ): Promise<Outcome<TaskStatsResult>[]> {
    return this.#collect(entries, "tasks", (p) =>
      (p as TaskProvider).getUserTaskStats({ period: query.period.period }),
    );
  }

  async #collect<T>(
    entries: ProviderEntry[],
    category: Provider["category"],
    run: (provider: Provider) => Promise<T>,
  ): Promise<Outcome<T>[]> {
    const { registry, credentials, config, fetch } = this.runtime;
    const relevant = entries.filter((e) => registry.categoryOf(e) === category);
    return Promise.all(
      relevant.map(async (entry): Promise<Outcome<T>> => {
        const source = registry.source(entry);
        const credential = credentials.get(entry.id) ?? {
          token: undefined,
          source: undefined,
          missingHint: "",
        };
        const instance = registry.instantiate(entry, credential, config.settings, fetch);
        if (!instance.ok) return { source, ok: false, message: instance.message };
        if (instance.provider.category !== category) {
          return {
            source,
            ok: false,
            message: `Adapter returned a ${instance.provider.category} provider.`,
          };
        }
        try {
          return { source, ok: true, data: await run(instance.provider) };
        } catch (error) {
          return { source, ok: false, message: errorMessage(error) };
        }
      }),
    );
  }

  #attribute(
    providerId: string,
    ref: ContributorRef,
    resolver: IdentityResolver,
    notes: NoteCollector,
  ): Attributed {
    const identity = resolver.resolve(providerId, ref);
    if (identity.match === "ambiguous") {
      notes.add(
        `"${ref.displayName}" from ${providerId} matches several identities (${identity.candidates.join(", ")}); kept separate. Add an explicit account mapping to resolve it.`,
      );
    }
    return { providerId, identity, ref };
  }

  #passesEmail(row: Attributed, query: ReportQuery, unknown: Map<string, number>): boolean {
    const outcome = emailFilterOutcome(row.identity, query.filters);
    if (outcome === "unknown") unknown.set(row.providerId, (unknown.get(row.providerId) ?? 0) + 1);
    return outcome === "match";
  }

  #buildGitRows(
    outcomes: Outcome<GitCommitStats[]>[],
    query: ReportQuery,
    notes: NoteCollector,
    resolver: IdentityResolver,
  ): GitReportRow[] {
    const rows = new Map<string, GitReportRow>();
    const unknownEmail = new Map<string, number>();
    for (const outcome of outcomes) {
      if (!outcome.ok) continue;
      const providerId = outcome.source.id;
      for (const stat of outcome.data) {
        if (!matchesRepository(stat.repository, query.filters)) continue;
        const attributed = this.#attribute(providerId, stat.author, resolver, notes);
        if (!this.#passesEmail(attributed, query, unknownEmail)) continue;
        const row = getOrCreate(rows, attributed, (base) => ({
          ...base,
          commits: 0,
          repositories: [],
        }));
        row.commits += stat.commits;
        row.repositories = addSorted(row.repositories, `${providerId}:${stat.repository}`);
        row.providers = addSorted(row.providers, providerId);
      }
    }
    noteUnknownEmail(notes, unknownEmail, "commit row");
    return [...rows.values()];
  }

  #buildTaskRows(
    outcomes: Outcome<TaskStatsResult>[],
    query: ReportQuery,
    notes: NoteCollector,
    resolver: IdentityResolver,
  ): TaskReportRow[] {
    const rows = new Map<string, TaskReportRow>();
    const unknownEmail = new Map<string, number>();
    for (const outcome of outcomes) {
      if (!outcome.ok) continue;
      const providerId = outcome.source.id;
      for (const stat of outcome.data.users) {
        const counts = applyStatusFilter(stat.counts, query.filters);
        if (!counts) continue;
        const attributed = this.#attribute(providerId, stat.assignee, resolver, notes);
        if (!this.#passesEmail(attributed, query, unknownEmail)) continue;
        const row = getOrCreate(rows, attributed, (base) => ({
          ...base,
          counts: emptyTaskCounts(),
        }));
        addCounts(row.counts, counts);
        row.providers = addSorted(row.providers, providerId);
      }
      if (outcome.data.unmappedStatuses.length > 0) {
        const total = outcome.data.unmappedStatuses.reduce((sum, s) => sum + s.count, 0);
        const detail = outcome.data.unmappedStatuses
          .map((s) => `${s.status}: ${s.count}`)
          .join(", ");
        notes.add(
          `${providerId}: excluded ${total} task(s) whose vendor status maps to no bucket (${detail}); counted across all assignees.`,
        );
      }
    }
    noteUnknownEmail(notes, unknownEmail, "task row");
    return [...rows.values()];
  }

  #report<K extends ReportKind>(
    kind: K,
    query: ReportQuery,
    sortKey: SortKey,
    outcomes: Outcome<unknown>[],
    rows: ActivityReport<K>["rows"],
    notes: NoteCollector,
  ): ActivityReport<K> {
    const failures: ProviderFailure[] = outcomes
      .filter((o): o is Outcome<unknown> & { ok: false; message: string } => !o.ok)
      .map((o) => ({ source: o.source, message: o.message }));
    return {
      kind,
      query,
      sortKey,
      sources: outcomes.map((o) => o.source),
      failures,
      rows,
      notes: notes.list(),
    };
  }
}

class NoteCollector {
  readonly #notes = new Set<string>();
  add(note: string): void {
    this.#notes.add(note);
  }
  list(): string[] {
    return [...this.#notes];
  }
}

function noteUnknownEmail(notes: NoteCollector, counts: Map<string, number>, what: string): void {
  for (const [providerId, count] of counts) {
    notes.add(
      `${providerId}: excluded ${count} ${what}(s) with no email and no identity mapping, because --email cannot be checked for them. Map these accounts under "identities" to include them.`,
    );
  }
}

function getOrCreate<T extends ContributorSummary>(
  rows: Map<string, T>,
  attributed: Attributed,
  create: (summary: ContributorSummary) => T,
): T {
  const { identity, ref } = attributed;
  let row = rows.get(identity.key);
  if (!row) {
    row = create({
      key: identity.key,
      displayName: identity.member?.name ?? ref.displayName,
      identity: identity.match,
      memberId: identity.member?.id,
      providers: [],
    });
    rows.set(identity.key, row);
  }
  return row;
}

function addSorted(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value].sort();
}

function addCounts(target: TaskCounts, add: TaskCounts): void {
  for (const status of TASK_STATUSES) target[status] += add[status];
}

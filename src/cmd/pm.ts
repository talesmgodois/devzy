import {
  type ActivityReport,
  type CombinedReportRow,
  DEFAULT_SORT_KEY,
  type GitReportRow,
  SORT_KEYS_BY_REPORT,
  type SortKey,
  type TaskReportRow,
} from "../domain/activity.ts";
import {
  describeFilters,
  FilterError,
  parseFilters,
  type ReportKind,
  type ReportQuery,
} from "../domain/filters.ts";
import { PeriodError, periodFromDates, REPORTING_TIMEZONE } from "../domain/period.ts";
import { TASK_STATUS_LABELS, TASK_STATUSES, type TaskCounts } from "../domain/tasks.ts";
import { DevzyError, ExitCode, type ExitCodeValue, UsageError } from "../lib/errors.ts";
import { type Column, formatCount, renderTable } from "../lib/table.ts";
import { ActivityService } from "../services/aggregation.ts";
import { parseCommandArgs, single } from "./args.ts";
import { type CommandContext, describeConfigSource } from "./context.ts";

export const PM_OPTION_SPEC = {
  "dt-since": { type: "string", multiple: true },
  "dt-to": { type: "string", multiple: true },
  email: { type: "string", multiple: true },
  provider: { type: "string", multiple: true },
  repo: { type: "string", multiple: true },
  status: { type: "string", multiple: true },
  sort: { type: "string", multiple: true },
  "allow-mixed-modes": { type: "boolean" },
} as const;

const REPORT_TITLES: Record<ReportKind, string> = {
  git: "Git activity",
  tasks: "Task activity",
  all: "Combined activity",
};

const CATEGORY_WORDS: Record<ReportKind, string> = {
  git: "Git",
  tasks: "task",
  all: "Git or task",
};

export async function runPmReport(
  ctx: CommandContext,
  kind: ReportKind,
  tokens: string[],
): Promise<ExitCodeValue> {
  const values = parseCommandArgs(tokens, PM_OPTION_SPEC, `devzy pm ${kind} --help`);
  const helpHint = `Run "devzy pm ${kind} --help" for usage.`;

  let query: ReportQuery;
  let sortKey: SortKey;
  const loaded = await ctx.config();
  try {
    const period = periodFromDates(
      { since: single(values["dt-since"], "dt-since"), to: single(values["dt-to"], "dt-to") },
      loaded.config.settings.defaultPeriodDays,
      ctx.deps.now(),
    );
    const filters = parseFilters(kind, {
      email: values.email,
      provider: values.provider,
      repo: values.repo,
      status: values.status,
    });
    query = { kind, period, filters };
    sortKey = parseSortKey(kind, single(values.sort, "sort"));
  } catch (error) {
    if (error instanceof PeriodError || error instanceof FilterError)
      throw new UsageError(error.message, helpHint);
    throw error;
  }

  const service = new ActivityService(await ctx.runtime());
  const options = { sortKey, allowMixedModes: values["allow-mixed-modes"] ?? false };
  let sources: ReturnType<ActivityService["selectSources"]>;
  try {
    sources = service.selectSources(query, options);
  } catch (error) {
    if (error instanceof FilterError) throw new UsageError(error.message, helpHint);
    throw error;
  }
  if (sources.length === 0) {
    throw new DevzyError(
      `No enabled ${CATEGORY_WORDS[kind]} providers are configured.`,
      ExitCode.Failure,
      'Run "devzy providers list" to review providers or "devzy providers add" to add one.',
    );
  }

  ctx.log.info(describeConfigSource(loaded));
  ctx.log.info(`Querying ${sources.length} provider(s)...`);
  const report =
    kind === "git"
      ? await service.gitReport(query, options)
      : kind === "tasks"
        ? await service.taskReport(query, options)
        : await service.combinedReport(query, options);

  for (const failure of report.failures) {
    ctx.log.error(
      `provider ${failure.source.id} (${failure.source.name}) failed: ${failure.message}`,
    );
  }
  if (report.failures.length === report.sources.length) {
    throw new DevzyError(
      "Every selected provider failed; no report was produced.",
      ExitCode.Failure,
    );
  }

  printReport(ctx, report);
  return report.failures.length > 0 ? ExitCode.Partial : ExitCode.Success;
}

function parseSortKey(kind: ReportKind, raw: string | undefined): SortKey {
  if (raw === undefined) return DEFAULT_SORT_KEY[kind];
  const value = raw.trim().toLowerCase().replace(/-/g, "_");
  const allowed = SORT_KEYS_BY_REPORT[kind];
  const match = allowed.find((k) => k === value);
  if (!match)
    throw new FilterError(
      `--sort for pm ${kind} must be one of: ${allowed.join(", ")} (got "${raw}").`,
    );
  return match;
}

function printReport(ctx: CommandContext, report: ActivityReport): void {
  const { log } = ctx;
  const { period, filters } = report.query;
  const periodNote = period.isDefault ? "; default period" : "";
  log.out(
    `${REPORT_TITLES[report.kind]}: ${period.firstDay} to ${period.lastDay} (inclusive, ${REPORTING_TIMEZONE}${periodNote})`,
  );
  const active = describeFilters(filters);
  log.out(`Filters: ${active.length > 0 ? active.join("; ") : "none"}`);
  log.out(`Sources: ${report.sources.map((s) => `${s.id} (${s.mode})`).join(", ")}`);
  log.out(`Sorted by: ${report.sortKey}${report.sortKey === "name" ? "" : " (descending)"}`);
  if (report.sources.some((s) => s.mode === "mock")) {
    const scope = report.sources.every((s) => s.mode === "mock")
      ? "All data"
      : "Data from sources marked (mock)";
    log.out(
      `MOCK DATA: ${scope} is generated by mock providers for demonstration; it is not real activity.`,
    );
  }
  if (report.failures.length > 0) {
    const failed = report.failures.map((f) => f.source.id).join(", ");
    log.out(
      `PARTIAL REPORT: ${report.failures.length} of ${report.sources.length} providers failed (${failed}); their activity is missing, not zero.`,
    );
  }
  log.out();

  if (report.rows.length === 0) {
    const scope = active.length > 0 ? " matching the active filters" : "";
    log.out(
      `No ${CATEGORY_WORDS[report.kind]} activity found between ${period.firstDay} and ${period.lastDay}${scope}.`,
    );
  } else {
    const { columns, rows } = tableFor(report);
    log.out(renderTable(columns, rows, { maxWidth: log.terminalWidth }));
    log.out();
    log.out(
      "Identity: mapped = configured identity; email = combined by exact email; unmapped = no email or mapping; ambiguous = matches several identities (kept separate).",
    );
  }

  if (report.notes.length > 0) {
    log.out();
    log.out("Notes:");
    for (const note of report.notes) log.out(`  - ${note}`);
  }
}

const BASE_COLUMNS: Column[] = [
  { header: "#", align: "right" },
  { header: "Contributor", flex: true },
  { header: "Identity" },
];

function taskCells(counts: TaskCounts | undefined, report: ActivityReport): string[] {
  const selected = report.query.filters.statuses;
  return TASK_STATUSES.map((status) => {
    if (selected.length > 0 && !selected.includes(status)) return "-";
    return formatCount(counts?.[status]);
  });
}

function tableFor(report: ActivityReport): { columns: Column[]; rows: string[][] } {
  const taskColumns: Column[] = TASK_STATUSES.map((s) => ({
    header: TASK_STATUS_LABELS[s],
    align: "right",
  }));
  const providersColumn: Column = { header: "Providers", flex: true };

  if (report.kind === "git") {
    const rows = (report.rows as GitReportRow[]).map((r, i) => [
      String(i + 1),
      r.displayName,
      r.identity,
      formatCount(r.commits),
      formatCount(r.repositories.length),
      r.providers.join(", "),
    ]);
    return {
      columns: [
        ...BASE_COLUMNS,
        { header: "Commits", align: "right" },
        { header: "Repos", align: "right" },
        providersColumn,
      ],
      rows,
    };
  }
  if (report.kind === "tasks") {
    const rows = (report.rows as TaskReportRow[]).map((r, i) => [
      String(i + 1),
      r.displayName,
      r.identity,
      ...taskCells(r.counts, report),
      r.providers.join(", "),
    ]);
    return { columns: [...BASE_COLUMNS, ...taskColumns, providersColumn], rows };
  }
  const rows = (report.rows as CombinedReportRow[]).map((r, i) => [
    String(i + 1),
    r.displayName,
    r.identity,
    formatCount(r.commits),
    ...taskCells(r.tasks, report),
    r.providers.join(", "),
  ]);
  return {
    columns: [
      ...BASE_COLUMNS,
      { header: "Commits", align: "right" },
      ...taskColumns,
      providersColumn,
    ],
    rows,
  };
}

import { isPlausibleEmail, normalizeEmail } from "./identity.ts";
import type { ResolvedPeriod } from "./period.ts";
import { isTaskStatus, TASK_STATUSES, type TaskStatus } from "./tasks.ts";

/** The reports that accept filters. */
export type ReportKind = "git" | "tasks" | "all";

export const REPORT_COMMANDS: Record<ReportKind, string> = {
  git: "pm git",
  tasks: "pm tasks",
  all: "pm all",
};

/**
 * Typed, shared filter model. Values within one category combine with OR;
 * different categories combine with AND. An empty array means "no filter".
 */
export interface ReportFilters {
  /** Normalized (trimmed, lowercased) email addresses. */
  emails: string[];
  /** Provider instance IDs or provider types, lowercased. */
  providers: string[];
  /** Repositories (`owner/name`), lowercased. */
  repositories: string[];
  statuses: TaskStatus[];
}

export type ListFilterKey = keyof ReportFilters;

export function emptyFilters(): ReportFilters {
  return { emails: [], providers: [], repositories: [], statuses: [] };
}

export interface ReportQuery {
  kind: ReportKind;
  period: ResolvedPeriod;
  filters: ReportFilters;
}

export class FilterError extends Error {
  override name = "FilterError";
}

/**
 * Declarative definition of a repeatable list filter. Adding a filter means
 * adding a field to {@link ReportFilters}, one definition here, and the
 * matching logic in services/filtering.ts; command handlers do not change.
 */
export interface FilterDefinition<K extends ListFilterKey = ListFilterKey> {
  key: K;
  flag: string;
  valueName: string;
  description: string;
  appliesTo: readonly ReportKind[];
  parse(raw: string): ReportFilters[K][number];
}

const REPO_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface DefinedFilter<K extends ListFilterKey> extends FilterDefinition<K> {
  /** Parses, de-duplicates and stores raw values on the filter model. */
  assign(filters: ReportFilters, raw: readonly string[]): void;
}

function defineFilter<K extends ListFilterKey>(def: FilterDefinition<K>): DefinedFilter<K> {
  return {
    ...def,
    assign(filters, raw) {
      const parsed = [...new Set(raw.map((value) => def.parse(value)))];
      filters[def.key] = parsed as ReportFilters[K];
    },
  };
}

export const FILTER_DEFINITIONS = [
  defineFilter({
    key: "emails",
    flag: "email",
    valueName: "<email>",
    description: "Only activity linked to this email (exact, case-insensitive).",
    appliesTo: ["git", "tasks", "all"],
    parse(raw) {
      const email = normalizeEmail(raw);
      if (!email || !isPlausibleEmail(email)) {
        throw new FilterError(`--email expects an email address (got "${raw}").`);
      }
      return email;
    },
  }),
  defineFilter({
    key: "providers",
    flag: "provider",
    valueName: "<id-or-type>",
    description: "Only this configured provider instance ID or provider type (e.g. github).",
    appliesTo: ["git", "tasks", "all"],
    parse(raw) {
      const value = raw.trim();
      if (!PROVIDER_RE.test(value)) {
        throw new FilterError(`--provider expects a provider ID or type (got "${raw}").`);
      }
      return value.toLowerCase();
    },
  }),
  defineFilter({
    key: "repositories",
    flag: "repo",
    valueName: "<owner/name>",
    description: "Only commits in this repository.",
    appliesTo: ["git"],
    parse(raw) {
      const value = raw.trim();
      if (!REPO_RE.test(value)) {
        throw new FilterError(`--repo expects a repository as owner/name (got "${raw}").`);
      }
      return value.toLowerCase();
    },
  }),
  defineFilter({
    key: "statuses",
    flag: "status",
    valueName: "<status>",
    description: `Only these task statuses: ${TASK_STATUSES.join(", ")}.`,
    appliesTo: ["tasks"],
    parse(raw) {
      const value = raw.trim().toLowerCase().replace(/-/g, "_");
      if (!isTaskStatus(value)) {
        throw new FilterError(
          `--status expects one of ${TASK_STATUSES.join(", ")} (got "${raw}").`,
        );
      }
      return value;
    },
  }),
] as const;

export type RawFilterValues = Partial<Record<string, readonly string[] | undefined>>;

/**
 * Parses raw repeatable CLI values (keyed by flag name) into the typed model.
 * Rejects filters that do not apply to the report kind instead of ignoring them.
 */
export function parseFilters(kind: ReportKind, raw: RawFilterValues): ReportFilters {
  const filters = emptyFilters();
  for (const def of FILTER_DEFINITIONS) {
    const values = raw[def.flag];
    if (!values || values.length === 0) continue;
    if (!def.appliesTo.includes(kind)) {
      const allowed = def.appliesTo.map((k) => `devzy ${REPORT_COMMANDS[k]}`).join(", ");
      throw new FilterError(
        `--${def.flag} cannot be used with devzy ${REPORT_COMMANDS[kind]}; it applies only to ${allowed}.`,
      );
    }
    def.assign(filters, values);
  }
  return filters;
}

/** Human-readable description of active filters, e.g. `["provider = github", "email = a@x.com"]`. */
export function describeFilters(filters: ReportFilters): string[] {
  const parts: string[] = [];
  for (const def of FILTER_DEFINITIONS) {
    const values: readonly string[] = filters[def.key];
    if (values.length > 0) parts.push(`${def.flag} = ${values.join(" | ")}`);
  }
  return parts;
}

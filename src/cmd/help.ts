import { DEFAULT_SORT_KEY, SORT_KEYS_BY_REPORT } from "../domain/activity.ts";
import { FILTER_DEFINITIONS, type ReportKind } from "../domain/filters.ts";
import { REPORTING_TIMEZONE } from "../domain/period.ts";

export const VERSION = "0.1.0";

const GLOBAL_OPTIONS = `Global options:
  -h, --help            Show help for a command
  -q, --quiet           Hide informational messages on stderr
      --non-interactive Never prompt (implied when stdin is not a terminal)
  -V, --version         Print the version`;

export const GLOBAL_HELP = `devzy ${VERSION} - developer activity across Git and task providers

Usage:
  devzy <command> [subcommand] [options]

Commands:
  pm git           Commits per contributor from Git providers
  pm tasks         Completed / in-progress / in-review tasks per contributor
  pm all           Combined Git and task activity per contributor
  providers list   Known provider types and configured providers (alias: devzy providers)
  providers add    Add a provider to the configuration
  health show      Run provider health checks (alias: devzy health)
  help             Show this help

Run "devzy <command> help" for details, e.g. "devzy pm help".

${GLOBAL_OPTIONS}

Exit codes: 0 success, 1 failure, 2 usage error, 3 partial result or failed
health check, 4 configuration error, 130 cancelled.`;

function filterLines(kind: ReportKind): string {
  return FILTER_DEFINITIONS.filter((d) => d.appliesTo.includes(kind))
    .map((d) => `  --${`${d.flag} ${d.valueName}`.padEnd(24)}${d.description} (repeatable)`)
    .join("\n");
}

const DATE_LINES = `  --dt-since <YYYY-MM-DD>   First day to include (inclusive)
  --dt-to <YYYY-MM-DD>      Last day to include (inclusive)`;

function reportOptionLines(kind: ReportKind): string {
  return `Options:
${DATE_LINES}
${filterLines(kind)}
  --sort <key>              ${SORT_KEYS_BY_REPORT[kind].join(" | ")} (default: ${DEFAULT_SORT_KEY[kind]})
  --allow-mixed-modes       Allow mock and live providers in one report`;
}

const FILTER_RULES = `Filter rules:
  - Dates are calendar days in ${REPORTING_TIMEZONE}; both bounds are inclusive. Without
    dates the report covers the last N days ending today (N = settings.defaultPeriodDays,
    default 30). With only --dt-since it runs to today; with only --dt-to it covers the
    N days ending on that date.
  - Repeating a filter matches ANY of its values (OR); different filters must ALL
    match (AND).
  - --email is exact and case-insensitive. Rows without an email and without an
    identity mapping cannot be checked; they are excluded and reported in the notes.
  - --repo applies only to "pm git"; --status applies only to "pm tasks". Using
    them elsewhere is an error.`;

const SUBCOMMAND_HELP: Record<ReportKind, string> = {
  git: `Usage: devzy pm git [options]

Commit counts per contributor across enabled Git providers. One row per
contributor; "Repos" counts distinct provider/repository pairs.

${reportOptionLines("git")}

${FILTER_RULES}

Examples:
  devzy pm git --dt-since 2026-01-01 --dt-to 2026-01-31
  devzy pm git --provider github --repo acme/api --email dev@example.com`,
  tasks: `Usage: devzy pm tasks [options]

Normalized task activity per contributor across enabled task providers.
Columns: Completed, In progress, In review / testing. Vendor statuses that map
to none of these are excluded and listed in the notes.

${reportOptionLines("tasks")}

${FILTER_RULES}

Examples:
  devzy pm tasks --dt-since 2026-01-01 --dt-to 2026-01-31
  devzy pm tasks --status completed --status in_review --provider jira`,
  all: `Usage: devzy pm all [options]

Combined Git and task metrics per contributor. Rows are combined only through
configured identities or identical email addresses, never by display name.
"-" means no records from that category for the contributor.

${reportOptionLines("all")}

${FILTER_RULES}

Examples:
  devzy pm all --dt-since 2026-01-01 --dt-to 2026-01-31
  devzy pm all --email dev@example.com --sort completed`,
};

export const PM_HELP = `Usage: devzy pm <git|tasks|all> [options]

Activity reports.

Subcommands:
  git     Commits per contributor
  tasks   Task status counts per contributor
  all     Combined Git and task activity

Run "devzy pm <subcommand> --help" for subcommand options.

Common options:
${DATE_LINES}
  --email <email>           Only activity linked to this email (repeatable)
  --provider <id-or-type>   Only these providers (repeatable)
  --repo <owner/name>       pm git only (repeatable)
  --status <status>         pm tasks only: completed | in_progress | in_review (repeatable)
  --sort <key>              Primary sort metric

${FILTER_RULES}

Ranking: the sort metric descending, then the other metrics (commits,
completed, in_review, in_progress) descending, then name, then a stable key.

Report output goes to stdout; diagnostics go to stderr. Exit code 3 means
at least one provider failed and the report is partial.

${GLOBAL_OPTIONS}`;

export function reportHelp(kind: ReportKind): string {
  return `${SUBCOMMAND_HELP[kind]}\n\n${GLOBAL_OPTIONS}`;
}

export const PROVIDERS_LIST_HELP = `Usage: devzy providers list

Lists the provider types this build knows (with mock/live adapter
availability) and the configured provider instances grouped by category.
Secret values are never shown; live providers show only where their token
comes from and whether it is set.

${GLOBAL_OPTIONS}`;

export const PROVIDERS_ADD_HELP = `Usage: devzy providers add [options]

Adds a provider to a configuration file. Prompts for missing values when
stdin is a terminal; otherwise all required values must be given as options.
Type "cancel" or press Ctrl+D at any prompt to stop without changes.

Options:
  --type <type>          Provider type, e.g. github, gitlab, jira, linear
  --mode <mock|live>     Adapter mode
  --id <id>              Unique instance ID (lowercase letters, digits, '-')
  --name <name>          Display name (default: derived from the type)
  --repo <owner/name>    Live GitHub: repository to report on (repeatable)
  --base-url <url>       Live GitHub: API URL (default https://api.github.com)
  --token-env <VAR>      Live GitHub: env variable holding the token (default GITHUB_TOKEN)
  --disabled             Save the provider as disabled
  --scope <user|project> File to write: user (~/.config/devzy/config.yaml, default)
                         or project (./devzy.yaml). When DEVZY_CONFIG_PATH is
                         set, that file is written and --scope is rejected.
  -y, --yes              Do not ask for confirmation

Tokens are never written by this command; only the name of the environment
variable that holds the token is saved.

Non-interactive example:
  devzy providers add --type github --mode live --id github-acme \\
    --repo acme/api --repo acme/web --token-env GITHUB_TOKEN

${GLOBAL_OPTIONS}`;

export const PROVIDERS_HELP = `Usage: devzy providers <list|add>

Subcommands:
  list   Show known provider types and configured providers (default)
  add    Add a provider to the configuration

Run "devzy providers <subcommand> --help" for details.

${GLOBAL_OPTIONS}`;

export const HEALTH_SHOW_HELP = `Usage: devzy health show [options]

Runs health checks for configured providers concurrently, each with a
timeout. Health is a capability: providers that do not implement it are
listed as not_supported; disabled providers as not_checked.

Statuses: healthy, unhealthy, timeout, error, not_supported, not_checked.

Options:
  --provider <id-or-type>  Only check these providers (repeatable)
  --timeout <ms>           Per-provider timeout (default: settings.healthTimeoutMs, 5000)

Exit code: 0 when no check is unhealthy, timeout or error; 3 otherwise.

${GLOBAL_OPTIONS}`;

export const HEALTH_HELP = `Usage: devzy health [show] [options]

Subcommands:
  show   Run health checks (default)

${HEALTH_SHOW_HELP.split("\n").slice(2).join("\n")}`;

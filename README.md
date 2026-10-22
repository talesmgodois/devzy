# devzy

`devzy` is a command-line tool that aggregates developer activity across Git
hosting and task-tracking providers, manages provider configuration, and checks
provider health.

A fresh installation works without any credentials: when no configuration file
exists, devzy uses a built-in set of **mock providers** with deterministic,
clearly labelled demo data.

## Contents

- [Capabilities](#capabilities)
- [Adapter status: mock vs live](#adapter-status-mock-vs-live)
- [Installation](#installation)
- [Development](#development)
- [Commands](#commands)
- [Reporting periods, filters and ranking](#reporting-periods-filters-and-ranking)
- [Identity matching](#identity-matching)
- [Configuration](#configuration)
- [Environment variables](#environment-variables)
- [Mock and live modes](#mock-and-live-modes)
- [Errors, partial results and exit codes](#errors-partial-results-and-exit-codes)
- [Security notes](#security-notes)
- [Known limitations](#known-limitations)
- [Adding a provider](#adding-a-provider)

## Capabilities

- `pm git`: commits per contributor across Git providers.
- `pm tasks`: completed, in-progress and in-review/testing task counts per contributor.
- `pm all`: combined Git and task metrics per contributor, joined through explicit identities.
- Shared filters on all reports: date range, email, provider, repository and task status.
- `providers list` / `providers add`: known provider types, configured instances, and guided setup.
- `health show`: per-provider health checks with timeouts.
- YAML configuration with environment-variable overrides and validation.

## Adapter status: mock vs live

| Type        | Category | Mock adapter    | Live adapter                         |
| ----------- | -------- | --------------- | ------------------------------------ |
| github      | git      | available       | **available** (GitHub REST API)      |
| gitlab      | git      | available       | not implemented                      |
| bitbucket   | git      | not implemented | not implemented                      |
| jira        | tasks    | available       | not implemented                      |
| linear      | tasks    | available       | not implemented                      |
| clickup     | tasks    | not implemented | not implemented                      |
| openproject | tasks    | not implemented | not implemented                      |

The only live integration is **GitHub**. It calls the REST API for real and is
tested against a stubbed `fetch`; no test uses the network. All other
implemented adapters are mock-only. Types marked "not implemented" are listed so
they can be recognised, but `providers add` refuses to save them, and an entry
added by hand fails explicitly instead of being ignored.

`devzy providers list` shows this table for the running build.

## Installation

Prerequisites: [Bun](https://bun.sh) **1.3.0 or later** (developed and tested with 1.3.10).

```bash
git clone <repository-url> devzy
cd devzy
bun install

# Run from the checkout
bun run src/bin/devzy.ts help
bun run dev -- pm all            # same, via the "dev" script

# Optional: put `devzy` on your PATH
bun link
devzy help
```

## Development

| Command                    | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `bun run dev -- <args>`    | Run the CLI from source                          |
| `bun test`                 | All tests (unit + CLI integration)               |
| `bun run test:unit`        | Unit tests only                                  |
| `bun run test:integration` | CLI integration tests only                       |
| `bun run typecheck`        | Strict TypeScript check (`tsc --noEmit`)         |
| `bun run lint`             | Lint with Biome                                  |
| `bun run format`           | Format with Biome (write)                        |
| `bun run format:check`     | Check formatting                                 |
| `bun run check`            | Type check + Biome (lint, format, imports) + tests |

Tests never use the network or real credentials. Configuration tests use
temporary directories and pass an isolated environment explicitly, so
`process.env` is never modified.

Biome's `useLiteralKeys` rule is disabled because it conflicts with the
TypeScript option `noPropertyAccessFromIndexSignature`, which requires
`env["NAME"]`-style access.

### Project layout

```text
src/
├── bin/devzy.ts            entry point
├── cmd/                    argument parsing, help, command handlers, rendering
├── domain/                 provider-independent models (period, filters, identity, git, tasks, reports)
├── services/
│   ├── config/             schema, discovery/merge/env overrides, atomic persistence
│   ├── aggregation.ts      Git / task / combined reports and failure capture
│   ├── filtering.ts        shared filter application
│   ├── identity-resolver.ts
│   ├── ranking.ts
│   ├── health.ts
│   └── providers/          registry, interfaces, GitHub live adapter, mock adapters
├── lib/                    table rendering, logger, redaction, prompts, errors
└── tests/{unit,integration}
```

Dependency direction: `cmd` → `services` → `domain`. Services and domain code
never import table rendering, prompts or command modules. Commands get provider
instances only through the registry.

## Commands

```text
devzy help | --help             Global help
devzy pm help                   Help for reports
devzy pm git                    Git activity
devzy pm tasks                  Task activity
devzy pm all                    Combined activity
devzy providers [list]          Known types and configured providers
devzy providers help
devzy providers add             Add a provider (interactive or with options)
devzy health [show]             Health checks
devzy health help
```

Every command also accepts `--help`, `--quiet` (hide informational stderr
messages) and `--non-interactive`. Report tables go to **stdout**; progress,
warnings and errors go to **stderr**.

### `devzy pm git | tasks | all`

```bash
devzy pm git --dt-since 2026-01-01 --dt-to 2026-01-31
devzy pm tasks --dt-since 2026-01-01 --dt-to 2026-01-31
devzy pm all --dt-since 2026-01-01 --dt-to 2026-01-31 --email dev@example.com
devzy pm git --provider github --repo org/project --email dev@example.com
devzy pm tasks --status completed --provider jira
devzy pm all --sort completed
```

Example (built-in demo configuration):

```text
$ devzy pm all --dt-since 2026-09-01 --dt-to 2026-09-30 --quiet
Combined activity: 2026-09-01 to 2026-09-30 (inclusive, UTC)
Filters: none
Sources: github-demo (mock), gitlab-demo (mock), jira-demo (mock), linear-demo (mock)
Sorted by: commits (descending)
MOCK DATA: All data is generated by mock providers for demonstration; it is not real activity.

 #  Contributor   Identity  Commits  Completed  In progress  In review / testing  Providers
--  ------------  --------  -------  ---------  -----------  -------------------  ------------------------------------------------
 1  Ana Souza     mapped         63         13           12                    5  github-demo, gitlab-demo, jira-demo, linear-demo
 2  Ben Carter    email          57          6            6                    4  github-demo, gitlab-demo, jira-demo
 ...
 6  Sam Lee       email          12          -            -                    -  github-demo
 8  Sam Lee       email           -         10            3                    6  jira-demo
 9  Ivo Petrov    unmapped        -          6            5                    2  jira-demo

Notes:
  - jira-demo: excluded 10 task(s) whose vendor status maps to no bucket (Blocked: 10); counted across all assignees.
```

The two "Sam Lee" rows are different people (different emails), so they are
not merged.

Columns:

- **pm git**: `#`, Contributor, Identity, Commits, Repos (distinct
  provider/repository pairs), Providers. No other metrics (additions, PRs, …)
  are reported, because no provider contract retrieves them.
- **pm tasks**: `#`, Contributor, Identity, Completed, In progress,
  In review / testing, Providers.
- **pm all**: `#`, Contributor, Identity, Commits, the three task columns,
  Providers. `-` means no records of that category for that contributor; with
  `--status`, it marks buckets that were filtered out.

What gets counted:

- **Commits** are counted per (repository, contributor) by the provider and
  summed. Live GitHub counts commits whose committer date is in the period,
  which is the date GitHub filters on.
- **Tasks** are counted when their status last changed within the period.
  Vendor statuses are normalized into `completed`, `in_progress` and
  `in_review`:

  | Jira                                      | Linear        | Bucket        |
  | ----------------------------------------- | ------------- | ------------- |
  | Done, Closed, Resolved                    | Done          | `completed`   |
  | In Progress, In Development               | In Progress   | `in_progress` |
  | In Review, Code Review, QA, Testing       | In Review     | `in_review`   |

  Matching is case-insensitive. Any other status (e.g. Blocked, Backlog,
  Canceled) is **unmapped**. Unmapped tasks are excluded from every column,
  never counted as completed, and listed in the report notes.

If no rows match, the report prints a message such as
`No Git activity found between 2026-09-01 and 2026-09-30 matching the active filters.`
instead of an empty table.

### `devzy providers list`

Prints the known provider types with their mock/live adapter availability, then
the configured instances grouped by category (`git`, `tasks`): ID, name, type,
enabled, mode, implementation status (`available` / `not implemented`), and
credential status. For live providers that is `$GITHUB_TOKEN (set)` or
`missing`, never the value. `devzy providers` is an alias.

Health is a **capability** that any provider may implement, not a separate
provider category.

### `devzy providers add`

Interactive when stdin is a terminal:

1. Lists every known type with its availability (mock + live, mock only, not implemented).
2. Explains what the selected type supports. Not-implemented types stop here;
   nothing is saved.
3. Asks for the mode (when there is a choice), ID, display name, and only the
   fields that adapter needs. Mock adapters ask for **no** credentials. Live
   GitHub asks for repositories, API URL and the **name** of the token's
   environment variable.
4. Validates every value, shows a summary and asks for confirmation.
5. Appends the entry without touching other entries, settings or comments,
   and confirms with the provider ID and file path.

Type `cancel` or press Ctrl+D at any prompt to stop (exit 130). Answering "n"
at the confirmation also leaves the file unchanged (exit 0).

When stdin is not a terminal, or with `--non-interactive`, nothing is prompted.
`--type`, `--mode` and `--id` are required, and any missing values are
reported:

```bash
devzy providers add --type jira --mode mock --id jira-demo
devzy providers add --type github --mode live --id github-acme \
  --repo acme/api --repo acme/web --token-env GITHUB_TOKEN
devzy providers add --type linear --mode mock --id linear --scope project   # writes ./devzy.yaml
```

Options: `--name`, `--disabled`, `--base-url` (GitHub Enterprise), `--scope
user|project`, `-y/--yes` (skip confirmation). Tokens are never written by this
command.

### `devzy health show`

```bash
devzy health
devzy health show --provider github --timeout 2000
```

Runs the checks concurrently, each with its own timeout (default
`settings.healthTimeoutMs` = 5000 ms). One check failing or hanging never
blocks the others. Columns: Provider, Name, Category, Mode, Status, Message.

| Status          | Meaning                                                    |
| --------------- | ---------------------------------------------------------- |
| `healthy`       | Check succeeded                                            |
| `unhealthy`     | Check completed and reported a problem                     |
| `timeout`       | No answer within the timeout                               |
| `error`         | The check threw, or the provider could not be initialised (e.g. missing token, adapter not implemented) |
| `not_supported` | The adapter does not implement health checks               |
| `not_checked`   | The provider is disabled                                   |

The live GitHub check calls `GET /user` and `GET /repos/{owner}/{repo}` for
each configured repository. Mock checks are simulated and say so.

**Exit code:** `0` if no check is `unhealthy`, `timeout` or `error`; `3`
otherwise.

## Reporting periods, filters and ranking

### Periods

- Dates are calendar days in **UTC**, given as `YYYY-MM-DD`. Both
  `--dt-since` and `--dt-to` are **inclusive**.
- Internally a period is the half-open interval
  `[since 00:00:00Z, (to + 1 day) 00:00:00Z)`. The conversion lives in one
  function, `periodFromDates` in `src/domain/period.ts`, and is tested at the
  boundaries.
- Defaults, with N = `settings.defaultPeriodDays` (30 unless configured):
  - no dates: the N days ending **today** (today included);
  - only `--dt-since`: from that day through today;
  - only `--dt-to`: the N days ending on that day.
- Malformed or impossible dates (e.g. `2026-02-30`), a start after the end,
  and repeated date options are rejected with exit code 2.
- The header always shows the resolved period.

### Filters

| Filter                    | Applies to                   | Matching                                                       |
| ------------------------- | ---------------------------- | -------------------------------------------------------------- |
| `--dt-since`, `--dt-to`   | git, tasks, all              | see above                                                      |
| `--email <email>`         | git, tasks, all              | exact match after trimming and lowercasing; no substrings      |
| `--provider <id-or-type>` | git, tasks, all              | configured instance ID or provider type (e.g. `github`)        |
| `--repo <owner/name>`     | **pm git only**              | case-insensitive exact repository                              |
| `--status <status>`       | **pm tasks only**            | `completed`, `in_progress`, `in_review` (`in-review` accepted) |

Rules:

- **Repeated values are OR**: `--email a@x.com --email b@x.com` matches either.
- **Different filters are AND**: `--provider github --email dev@example.com`
  means activity from GitHub providers that also matches the email.
- **Incompatible filters are errors**, not ignored: `--repo` with `pm tasks` or
  `pm all`, and `--status` with `pm git` or `pm all`, exit with code 2.
- `--provider` values must match an enabled provider of a category the report
  covers. Unknown IDs, wrong categories (`pm git --provider jira`) and
  disabled-only matches are rejected.
- `--repo` is passed to providers (live GitHub only queries matching
  configured repositories) and re-applied locally. A filter never widens
  the configured scope.
- `--email` is applied to normalized data after identity resolution. A row
  matches if its own email, or any email of the identity it maps to, is
  listed. Rows with **no email and no identity mapping** cannot be checked.
  They are excluded and the report notes how many were excluded per provider.
  This is the documented policy for providers like Jira, which can hide
  emails. Map those accounts under `identities` to include them.
- `--status` keeps only the selected buckets. Contributors left with nothing
  are dropped, and unselected columns show `-`.
- The report header lists the active filters.

New filters are added in one place (`FILTER_DEFINITIONS` in
`src/domain/filters.ts`, plus their matching logic in `src/services/filtering.ts`).
Command handlers do not change.

### Ranking

1. The sort metric, descending: `--sort` (default `commits` for `pm git` and
   `pm all`, `completed` for `pm tasks`). `--sort name` sorts alphabetically.
2. The report's other metrics, descending, in the order commits, completed,
   in_review, in_progress.
3. Display name, case-insensitive, ascending.
4. Internal aggregation key, so the order is total and stable.

Missing values (`-`) count as 0 for sorting. devzy has no composite "activity
score".

## Identity matching

Rows from providers are resolved to contributors in this order:

1. **Explicit account mapping**: `identities[].accounts` lists a provider
   instance ID plus `userId` (exact match, e.g. GitHub numeric ID or Jira
   accountId) or `username` (case-insensitive).
2. **Identity email**: the row's email (trimmed, lowercased) appears in an
   identity's `emails`. List aliases here, e.g. a personal address or GitHub
   noreply address.
3. **Same email, no identity**: rows from any providers with the same
   normalized email are combined (`Identity: email`).
4. **No email and no mapping**: kept separate per provider account
   (`Identity: unmapped`) and never merged across providers.

Rules:

- **Display names are never used for matching.** Two "Sam Lee"s with
  different emails stay separate.
- If an account or email matches **more than one** identity, the row is
  `ambiguous`. It is kept separate, nothing is guessed, and a note explains
  how to resolve it. Shared emails or accounts in the configuration also
  produce a warning at load time.
- An explicit account mapping wins over an email match.
- Email normalization is `trim` plus lowercase of the whole address. No
  provider-specific rewriting (dots, `+tags`) is done.

## Configuration

### Locations and merge rules

| Source            | Path                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| Explicit          | `$DEVZY_CONFIG_PATH` (alias: `devzy_CONFIG_PATH`)                     |
| User              | `$XDG_CONFIG_HOME/devzy/config.yaml`, else `~/.config/devzy/config.yaml` |
| Project           | `./devzy.yaml` (current directory)                                    |

- If `DEVZY_CONFIG_PATH` is set, **only** that file is read, and it must exist
  (exit 4 otherwise). If the canonical variable and the alias are set to
  different paths, that is an error.
- Otherwise the user file and then the project file are read, if they exist,
  and merged:
  - `settings`: per key; the project file wins.
  - `providers` and `identities`: per `id`. A project entry replaces the user
    entry with the same ID entirely (keeping its position); new IDs are appended.
- If no file exists, the **built-in demo configuration** is used: four mock
  providers (`github-demo`, `gitlab-demo`, `jira-demo`, `linear-demo`) and two
  identities. As soon as any configuration file exists, the demo configuration
  is no longer used.
- `providers add` writes to the user file by default, `./devzy.yaml` with
  `--scope project`, or the `DEVZY_CONFIG_PATH` file when that is set.

### Precedence

1. Built-in defaults
2. Configuration file values (merged as above)
3. Environment variables
4. CLI options, where a command has one (`--dt-since`/`--dt-to` override the
   default period; `health --timeout` overrides `healthTimeoutMs`)

An unset **or empty** environment variable never erases a configured value.

### Schema

See [`devzy.example.yaml`](devzy.example.yaml) (placeholder values only; a
test keeps it valid).

```yaml
version: 1                     # optional, must be 1
settings:
  defaultPeriodDays: 30        # 1-3660
  healthTimeoutMs: 5000        # 100-120000
  requestTimeoutMs: 15000      # 100-300000, used by live adapters
providers:
  - id: github-acme            # unique; lowercase letters, digits, '-'
    type: github               # github | gitlab | bitbucket | jira | linear | clickup | openproject
    name: GitHub (acme)
    enabled: true              # default true
    mode: live                 # mock | live (required, explicit)
    options:                   # validated by the adapter
      repositories: [acme/api]
      baseUrl: https://api.github.com
    credentials:               # live adapters only
      tokenEnv: GITHUB_TOKEN   # preferred: name of an env variable
      # token: ...             # discouraged inline token; never printed
identities:
  - id: ana
    name: Ana Souza
    emails: [ana@example.com]
    accounts:
      - { provider: github-acme, userId: "12345" }
      - { provider: jira-main, username: ana.souza }
```

Options by adapter:

- **github (live)**: `repositories` (required, `owner/name`), `baseUrl`
  (default `https://api.github.com`; set it to `https://host/api/v3` for
  GitHub Enterprise Server).
- **mock adapters**: `health` (`healthy` | `unhealthy` | `timeout` | `error`),
  `failReports` (`true` simulates a failing provider). Mock Git adapters also
  accept `repositories` to rename the fixture repositories.

Unknown keys are rejected everywhere. Validation errors give the file path and
field path (e.g. `providers[0].options.repositories: must list at least one
repository`) and never print values. YAML syntax errors give only the line and
column, never the file contents.

### Writing

`providers add` creates missing directories (mode `0700`) and writes the file
with mode `0600`, atomically: it writes a temporary file in the same directory
and renames it into place. Before writing it:

- refuses to modify an existing file that is not valid YAML or not a valid devzy configuration;
- validates the resulting file and the merged configuration (for example, duplicate IDs across files).

Comments and unrelated content are preserved.

## Environment variables

| Variable                    | Effect                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| `DEVZY_CONFIG_PATH`         | Use exactly this configuration file (alias `devzy_CONFIG_PATH`)     |
| `XDG_CONFIG_HOME`           | Base directory for the user file                                    |
| `DEVZY_DEFAULT_PERIOD_DAYS` | Overrides `settings.defaultPeriodDays`                              |
| `DEVZY_HEALTH_TIMEOUT_MS`   | Overrides `settings.healthTimeoutMs`                                |
| `DEVZY_REQUEST_TIMEOUT_MS`  | Overrides `settings.requestTimeoutMs`                               |
| `GITHUB_TOKEN`              | Token for a live GitHub provider. See the rules below               |
| *custom*                    | Any variable named by a provider's `credentials.tokenEnv`           |

Token resolution for a live provider (first non-empty value wins):

1. The variable named by `credentials.tokenEnv`.
2. The type's conventional variable (`GITHUB_TOKEN`). This applies **only if
   `tokenEnv` is not set and this is the only live provider of that type**.
   With several live GitHub providers, devzy does not guess; each one needs
   its own `tokenEnv`.
3. `credentials.token` from the file.

`JIRA_API_KEY` and similar variables are not read, because no live Jira (or
other) adapter exists yet.

## Mock and live modes

- Each provider entry states `mode: mock` or `mode: live` explicitly.
- Mock adapters need no credentials or network. Their data comes from fixed,
  fictional fixtures (example.com addresses). Commits and task changes are
  generated per UTC day from a hash of (provider ID, repository, contributor,
  date), so:
  - the same configuration and period always give the same output;
  - nothing is generated outside the requested period, and totals of adjacent
    periods add up;
  - two mock instances with different IDs produce different numbers.
- The fixtures deliberately include awkward cases: an alias email, a GitHub
  noreply address, a Jira user with a hidden email, two different people both
  named "Sam Lee", a bot account, and unmapped statuses.
- Every report that includes mock data says `MOCK DATA` in its header. Health
  output marks mock checks as simulated.
- Reports **refuse to mix** mock and live providers (exit 2) unless you pass
  `--allow-mixed-modes`; then the `Sources:` line lists each provider's mode.
- devzy never falls back from live to mock. A live provider that fails
  (authentication, network, missing token) appears as a failure.

## Errors, partial results and exit codes

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| 0    | Success (including an empty report and a declined `providers add` confirmation) |
| 1    | Failure: every selected provider failed, no enabled provider for the report, a not-implemented type in `providers add`, a write error |
| 2    | Usage error: unknown command/option, invalid value, incompatible filters, mixed modes |
| 3    | Partial: a report was printed but at least one provider failed, or a health check was unhealthy, timed out or errored |
| 4    | Configuration error: malformed or invalid file, missing `DEVZY_CONFIG_PATH` file, bad environment override |
| 130  | Interactive prompt cancelled                                                    |

Provider failures in reports:

- Providers are queried concurrently and every failure is captured per provider.
- A failed provider is **never** shown as zero activity. The header says
  `PARTIAL REPORT: 1 of 2 providers failed (gl-broken); their activity is missing, not zero.`,
  and stderr has `error: provider gl-broken (...) failed: <reason>`.
- If every selected provider fails, no table is printed and the exit code is 1.

## Security notes

- Tokens are only read from environment variables or the config file. They are
  sent only to the configured API host: the GitHub adapter refuses to follow a
  pagination link to another host.
- All output (stdout and stderr) goes through a redactor that removes every
  resolved token value, plus common token shapes (`ghp_…`, `github_pat_…`,
  `glpat-…`, `lin_api_…`, `Bearer …`).
- API error messages are built from status codes, never from response bodies.
- Unexpected errors print only a message, never a stack trace.
- `.gitignore` excludes `devzy.yaml`. Commit only `devzy.example.yaml`.

## Known limitations

- Only GitHub has a live adapter. GitLab, Jira and Linear are mock-only;
  Bitbucket, ClickUp and OpenProject have no adapter.
- Live GitHub reads the default branch's history (`GET /commits` without
  `sha`). Commits only on other branches are not counted. More than 5,000
  commits for one repository in one period is rejected rather than truncated.
- Live GitHub requests repositories one at a time.
- Dates are UTC only; no configurable timezone.
- No machine-readable (JSON) output yet.
- Unmapped task-status counts are reported per provider, not per assignee.
- Table width uses `Bun.stringWidth`; very narrow terminals truncate the name
  and provider columns.

## Adding a provider

1. **Catalog**: if the type is new, add it to `PROVIDER_TYPES` in
   `src/services/providers/catalog.ts` with its category.
2. **Adapter**: implement `GitProvider` (`getCommitStats`) or `TaskProvider`
   (`getUserTaskStats`) from `src/services/providers/{git,tasks}/*.interface.ts`.
   Convert vendor responses to the domain models at the adapter boundary
   (`GitCommitStats` rows per repository and contributor, or
   `summarizeTaskEvents` with a status mapping). Implement `HealthCheckable`
   only if the service can actually be checked.
3. **Definition**: export an `AdapterDefinition` with `mode`, an
   `optionsSchema` (zod), `setupFields` for `providers add`, an optional
   `credential` spec (`defaultEnv`), and `create()`.
4. **Register**: add it to `BUILT_IN_ADAPTERS` in
   `src/services/providers/registry.ts`. Commands, aggregation, filters,
   `providers list/add` and `health` pick it up automatically.
5. **Tests**: add adapter tests with an injected `fetch` (see
   `src/tests/unit/github-live.test.ts`), covering pagination, error mapping
   and that tokens never appear in errors.
6. **Docs**: update the adapter table at the top of this README.

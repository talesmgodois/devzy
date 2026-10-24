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
- [Live providers](#live-providers)
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
- [Contributing](CONTRIBUTING.md) · [Releasing](RELEASING.md)

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
| gitlab      | git      | available       | **available** (GitLab REST API v4)   |
| bitbucket   | git      | not implemented | not implemented                      |
| jira        | tasks    | available       | **available** (Jira Cloud REST v3)   |
| linear      | tasks    | available       | not implemented                      |
| clickup     | tasks    | not implemented | not implemented                      |
| openproject | tasks    | not implemented | **available** (OpenProject API v3)   |

The live adapters (GitHub, GitLab, Jira Cloud, OpenProject) call the vendors'
APIs for real. They are tested against a stubbed `fetch`; no test uses the
network, and none has been run in CI against a real account. Linear is
mock-only. Types marked "not implemented" are listed so they can be
recognised, but `providers add` refuses to save them, and an entry added by
hand fails explicitly instead of being ignored.

`devzy providers list` shows this table for the running build.

## Live providers

All live adapters share these rules:

- **Timeouts and retries.** Every request uses `settings.requestTimeoutMs`.
  HTTP 429, 502, 503 and 504 are retried at most twice, waiting for
  `Retry-After` (capped at 10 s) or 0.5 s / 1 s. Other errors are not retried.
- **Errors.** 401 (bad credentials), 403 (missing permission), 404 (missing or
  inaccessible project), rate limits, server errors, timeouts and network
  failures get distinct messages. Messages never include tokens or response
  bodies. A failed provider makes the report partial (exit 3); it never shows
  as zero activity, and devzy never falls back to mock data.
- **Pagination.** Bulk list endpoints with 100 items per page. Each adapter
  has a page cap; going over it is an error asking you to narrow the period,
  never a silent truncation.
- **Host pinning.** Tokens are sent only to the configured host; pagination
  links to another host are refused.
- **Identity.** Adapters fill account IDs and emails only when the API returns
  them and never look users up one by one. Jira and OpenProject usually hide
  emails, so link those accounts to people with `identities[].accounts`
  (provider instance ID + `userId`). Without a mapping they appear as
  `unmapped` and can't match `--email`.
- **Status mapping.** Jira and OpenProject statuses map to `completed`,
  `in_progress` and `in_review` through built-in tables, which you can extend
  or override per provider with `options.statusMap` (case-insensitive):

  ```yaml
  options:
    statusMap:
      Blocked: in_progress
      "Ready for QA": in_review
      Done: completed
  ```

  Statuses that map to nothing (e.g. "Won't Do", "Rejected") are excluded and
  listed in the report notes.

### GitHub

GitHub.com or GitHub Enterprise Server (`baseUrl: https://host/api/v3`). Token:
classic token with `repo` (private) or no scope (public), or a fine-grained
token with *Contents: read*. Counts default-branch commits by committer date.
Health: `GET /user` plus each repository.

### GitLab

| Option     | Required | Notes                                                        |
| ---------- | -------- | ------------------------------------------------------------ |
| `projects` | yes      | Full paths, e.g. `acme/api`, `group/subgroup/project`        |
| `baseUrl`  | no       | Instance root, default `https://gitlab.com`. `/api/v4` is appended, so sub-path installs (`https://host/gitlab`) work |

- Deployments: GitLab.com and self-managed.
- Token: personal, group or project access token with the **`read_api`**
  scope (Reporter role or higher on the projects), sent as `PRIVATE-TOKEN`.
  Default variable `GITLAB_TOKEN`.
- Data: `GET /projects/:path/repository/commits` on the default branch, with
  `since`/`until`. Commits are counted by `committed_date` inside the exact
  period. GitLab commits carry no account ID, so authors are identified by
  email. A project with an empty repository or no default branch reports no
  commits rather than an error. `--repo` narrows the queried projects.
- Page cap: 50 pages (5,000 commits) per project and period.
- Health: `GET /user` plus each project.

### Jira (Cloud)

| Option      | Required | Notes                                                     |
| ----------- | -------- | --------------------------------------------------------- |
| `baseUrl`   | yes      | Site root, e.g. `https://your-site.atlassian.net`         |
| `email`     | yes      | Atlassian account email used for authentication           |
| `projects`  | yes      | Project keys, e.g. `[ENG, OPS]`                           |
| `jql`       | no       | Extra JQL clause, combined with `AND` (file only)         |
| `statusMap` | no       | Status overrides (file only)                              |

- Deployments: Jira Cloud only (Data Center/Server is not supported).
- Token: an API token created at
  <https://id.atlassian.com/manage-profile/security/api-tokens> for the
  account in `email`, sent as Basic auth. The account needs **Browse
  projects** on each project. Default variable `JIRA_API_TOKEN`.
- Data: enhanced search `GET /rest/api/3/search/jql` with `nextPageToken`
  pagination (50 issues per page) and `expand=changelog`, requesting only
  `assignee`, `status`, `statuscategorychangedate`, `updated` and `created`.
  JQL dates use the Jira user's timezone, so the query window is widened by a
  day and the exact UTC period is re-checked locally.
- **"Status last changed":** taken from the change history that the search
  returns with each issue, so moves inside one status category (e.g.
  In Progress → In Code Review → In Test) count. No per-issue requests are
  made. Jira returns only the newest ~40 history entries per issue. If none
  of them is a status change, an issue whose oldest returned entry predates
  the period is treated as unchanged in the period; only in the rare case of
  40+ non-status edits inside the period does devzy fall back to
  `statuscategorychangedate`, then `updated`.
- Unassigned issues are excluded and counted in the notes.
- Page cap: 200 pages (10,000 issues); add `jql` to narrow larger projects.
- Health: `GET /rest/api/3/myself` plus each project.

Default Jira mapping: Done, Closed, Resolved → completed; In Progress,
In Development → in_progress; In Review, Code Review, In Code Review,
Ready for Review, Peer Review, QA, In QA, Ready for QA, Testing, In Test,
In Testing, Ready for Test → in_review. Workflow-specific statuses (e.g.
"Ship It", "QA Verified") need `options.statusMap`. Check the report notes
for statuses that map to no bucket.

### OpenProject

| Option      | Required | Notes                                                   |
| ----------- | -------- | ------------------------------------------------------- |
| `baseUrl`   | yes      | Instance root; `/api/v3` is appended                    |
| `projects`  | yes      | Project identifiers (e.g. `website`) or numeric IDs     |
| `statusMap` | no       | Status overrides (file only)                            |

- Deployments: self-hosted and OpenProject cloud.
- Token: create an API token under *My account → Access tokens*. It's sent as
  Basic auth with user `apikey`. The user needs **View work packages** on
  each project. Default variable `OPENPROJECT_API_KEY`.
- Data: `GET /api/v3/projects/{id}/work_packages` filtered on `updatedAt`
  (`<>d`, widened by a day and re-checked locally), paged by page number
  (`offset`).
- **"Status last changed" approximation:** work packages expose no status
  change date, so a work package counts when it was **last updated** inside
  the period, bucketed by its current status. A later edit moves it out of
  the period.
- Work packages without an assignee, or assigned to a group or placeholder
  user, are excluded and counted in the notes.
- Page cap: 100 pages per project.
- Health: `GET /api/v3/users/me` plus each project.

Default OpenProject mapping: Closed, Resolved → completed; In progress →
in_progress; Developed, In testing, Tested, In review → in_review. Rejected,
On hold and the planning statuses (New, Specified, …) are unmapped.

### Example: all four live providers

```bash
export GITHUB_TOKEN=... GITLAB_TOKEN=... JIRA_API_TOKEN=... OPENPROJECT_API_KEY=...
devzy providers add --type github --mode live --id gh --repo acme/api
devzy providers add --type gitlab --mode live --id gl --project acme/infra
devzy providers add --type jira --mode live --id jira \
  --base-url https://acme.atlassian.net --account-email you@example.com --project ENG
devzy providers add --type openproject --mode live --id op \
  --base-url https://openproject.example.com --project website
devzy health
devzy pm git --dt-since 2026-01-01 --dt-to 2026-01-31
devzy pm tasks --provider jira --status completed
devzy pm all --email you@example.com
```

Troubleshooting:

- `Missing credentials`: the token variable isn't set, or several live
  providers of one type exist and each needs `credentials.tokenEnv`.
- `HTTP 401`: wrong token, or for Jira, a token that doesn't belong to
  `email`.
- `HTTP 403` / `404` on a project: the account lacks access, or the path, key
  or identifier is wrong. `devzy health` checks every configured project.
- A person appears twice in `pm all`: their task-tracker account has no
  visible email. Add an `identities[].accounts` entry.

## Installation

Requires **Node.js 22 or later**. Bun is not needed to run devzy.

```bash
npm install -g devzy
devzy --help

# or without installing
npx devzy --help
```

> The npm package has not been published yet; until the first release (see
> [RELEASING.md](RELEASING.md)), install from source as below.

Try it without any configuration: `devzy pm all` uses built-in mock data.

### From source (Bun)

Development uses [Bun](https://bun.sh) 1.3.10.

```bash
git clone <repository-url> devzy
cd devzy
bun install --frozen-lockfile
bun run dev -- help              # run from source with Bun

bun run build                    # or build the Node.js executable
node dist/devzy.js --help
```

### Credentials and `.env` files

devzy reads tokens from environment variables (see
[Environment variables](#environment-variables)). Where they come from
depends on how you run it:

- **Installed from npm (Node.js):** `.env` files are **not** loaded. Export
  the variables in your shell, or load a file explicitly:
  `node --env-file=.env "$(command -v devzy)" pm all`.
- **From source with Bun:** Bun loads `.env`, `.env.local` and
  `.env.<NODE_ENV>` from the current directory automatically. Variables
  already set in the shell take precedence.

devzy never loads `.env` files itself. Loading them from whatever directory
you run it in could pick up unrelated secrets.

### Troubleshooting installation

| Symptom                                                    | Fix                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `devzy: command not found` after `npm install -g`          | Add npm's global bin directory to `PATH` (`npm prefix -g`, then its `bin/`) |
| `npm WARN EBADENGINE` or `SyntaxError` / `TypeError` at start | Upgrade to Node.js 22+ (`node --version`)                          |
| Tokens from `.env` are ignored                             | Expected under Node; see [Credentials and `.env` files](#credentials-and-env-files) |

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
| `bun run build`            | Build `dist/devzy.js` (Node.js ESM, `#!/usr/bin/env node`) |
| `bun run pack:check`       | Build and verify the npm tarball contents        |
| `bun run smoke`            | Install the packed tarball and run it with Node 22+ |
| `bun run check`            | Everything CI runs: types, Biome, tests, package, smoke |

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and
[RELEASING.md](RELEASING.md) for the release process. CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same checks
on pull requests and `main`, and smoke-tests the package on Node 22 and 24,
Linux, macOS and Windows.

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
│   └── providers/          registry, interfaces, shared HTTP client, live and mock adapters
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

 #  Contributor   Identity  Commits  Completed  In progress  In review / testing  Total  Providers
--  ------------  --------  -------  ---------  -----------  -------------------  -----  ------------------------------------------------
 1  Ana Souza     mapped         63         13           12                    5     30  github-demo, gitlab-demo, jira-demo, linear-demo
 2  Ben Carter    email          57          6            6                    4     16  github-demo, gitlab-demo, jira-demo
 ...
 6  Sam Lee       email          12          -            -                    -      -  github-demo
 8  Sam Lee       email           -         10            3                    6     19  jira-demo
 9  Ivo Petrov    unmapped        -          6            5                    2     13  jira-demo

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
  In review / testing, Total, Providers. Total is the sum of the three task
  columns; with `--status` it sums only the selected statuses.
- **pm all**: `#`, Contributor, Identity, Commits, the three task columns,
  Total, Providers. `-` means no records of that category for that
  contributor; with `--status`, it marks buckets that were filtered out.

What gets counted:

- **Commits** are counted per (repository, contributor) by the provider and
  summed. Live GitHub and GitLab count commits whose committer date is in the
  period.
- **Tasks** are counted when their status last changed within the period.
  Vendor statuses are normalized into `completed`, `in_progress` and
  `in_review`:

  | Jira                                      | Linear        | Bucket        |
  | ----------------------------------------- | ------------- | ------------- |
  | Done, Closed, Resolved                    | Done          | `completed`   |
  | In Progress, In Development               | In Progress   | `in_progress` |
  | In Review, (In) Code Review, QA, In Test, Ready for Test, … (full list under [Jira](#jira-cloud)) | In Review | `in_review` |

  Matching is case-insensitive. Live Jira and OpenProject providers can extend
  these tables with `options.statusMap` (see [Live providers](#live-providers)).
  Any other status (e.g. Blocked, Backlog, Canceled) is **unmapped**. Unmapped tasks are excluded from every column,
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
   adapters ask for their options (GitHub: repositories and API URL; GitLab:
   projects and URL; Jira: site URL, account email and project keys;
   OpenProject: URL and projects) and the **name** of the token's
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
devzy providers add --type gitlab --mode live --id gitlab --project acme/infra
devzy providers add --type jira --mode live --id jira --base-url https://acme.atlassian.net \
  --account-email you@example.com --project ENG
devzy providers add --type openproject --mode live --id op \
  --base-url https://openproject.example.com --project website
devzy providers add --type linear --mode mock --id linear --scope project   # writes ./devzy.yaml
```

Options: `--name`, `--disabled`, `--repo` (GitHub), `--project` (GitLab, Jira,
OpenProject; repeatable), `--base-url`, `--account-email` (Jira),
`--token-env`, `--scope user|project`, `-y/--yes` (skip confirmation). A flag
that doesn't apply to the chosen adapter is an error. `statusMap` and `jql`
are set in the file only. Tokens are never written by this command.

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

Live checks authenticate and then confirm access to every configured
repository or project (see [Live providers](#live-providers)). Mock checks are
simulated and say so.

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
- **gitlab (live)**: `projects` (required), `baseUrl` (default `https://gitlab.com`).
- **jira (live)**: `baseUrl`, `email`, `projects` (required), `jql`, `statusMap`.
- **openproject (live)**: `baseUrl`, `projects` (required), `statusMap`.
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
| `GITLAB_TOKEN`              | Token for a live GitLab provider                                    |
| `JIRA_API_TOKEN`            | API token for a live Jira provider (with `options.email`)           |
| `OPENPROJECT_API_KEY`       | API token for a live OpenProject provider                           |
| *custom*                    | Any variable named by a provider's `credentials.tokenEnv`           |

Token resolution for a live provider (first non-empty value wins):

1. The variable named by `credentials.tokenEnv`.
2. The type's conventional variable (`GITHUB_TOKEN`, `GITLAB_TOKEN`,
   `JIRA_API_TOKEN`, `OPENPROJECT_API_KEY`). This applies **only if
   `tokenEnv` is not set and this is the only live provider of that type**.
   With several live providers of one type, devzy does not guess; each one
   needs its own `tokenEnv`.
3. `credentials.token` from the file.

`JIRA_API_KEY` (an older naming) is not read; use `JIRA_API_TOKEN` or set
`credentials.tokenEnv`.

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
  sent only to the configured API host: live adapters refuse to follow a
  pagination link to another host. Base URLs must be http(s) without embedded
  credentials.
- All output (stdout and stderr) goes through a redactor that removes every
  resolved token value, plus common token shapes (`ghp_…`, `github_pat_…`,
  `glpat-…`, `lin_api_…`, `Bearer …`).
- API error messages are built from status codes, never from response bodies.
- Unexpected errors print only a message, never a stack trace.
- `.gitignore` excludes `devzy.yaml`. Commit only `devzy.example.yaml`.

## Known limitations

- Live adapters exist for GitHub, GitLab, Jira Cloud and OpenProject. Linear
  is mock-only; Bitbucket and ClickUp have no adapter, and OpenProject has no
  mock adapter. Jira Data Center/Server is not supported.
- Live GitHub and GitLab read the default branch only. Commits only on other
  branches are not counted. More than 5,000 commits for one repository in one
  period is rejected rather than truncated.
- Live adapters request repositories and projects one at a time.
- OpenProject counts the last update, not the last status change. Jira uses
  the embedded change history (see [Live providers](#live-providers)).
  See [Live providers](#live-providers) for what these approximations miss.
- Jira and OpenProject usually hide emails, so `--email` needs
  `identities[].accounts` mappings for their users.
- The live adapters are tested only against stubbed HTTP responses.
- Dates are UTC only; no configurable timezone.
- No machine-readable (JSON) output yet.
- Unmapped task-status counts are reported per provider, not per assignee.
- Very narrow terminals truncate the name and provider columns.
- Configuration file permissions (`0600`/`0700`) are best-effort on Windows.

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
5. **HTTP**: use `HttpClient` from `src/services/providers/http.ts` for
   timeouts, bounded retries, same-origin checks and status-code errors (see
   `gitlab.provider.ts`, `jira.provider.ts`, `openproject.provider.ts`).
6. **Tests**: add adapter tests with an injected `fetch` (see
   `src/tests/http-stub.ts` and `src/tests/unit/gitlab-live.test.ts`),
   covering pagination, error mapping and that tokens never appear in errors.
7. **Docs**: update the adapter table and the "Live providers" section.

# Contributing to devzy

## Setup

Requirements: [Bun](https://bun.sh) 1.3.10 (development and tests) and
Node.js 22 or later (to run the built package and the smoke test).

```bash
bun install --frozen-lockfile
bun run dev -- help            # run from source with Bun
```

## Scripts

| Command                    | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `bun run format`           | Format with Biome                                                 |
| `bun run format:check`     | Check formatting                                                  |
| `bun run lint`             | Lint with Biome                                                   |
| `bun run typecheck`        | Strict TypeScript check                                           |
| `bun test`                 | Unit and CLI integration tests (no network, no credentials)       |
| `bun run build`            | Build `dist/devzy.js` for Node.js                                 |
| `bun run pack:check`       | Build and verify the npm tarball contents (allowlist, no secrets) |
| `bun run smoke`            | Install the packed tarball in a temp dir and run it with Node     |
| `bun run check`            | All of the above, as CI runs them                                 |

The smoke test uses the `node` on your PATH (or `SMOKE_NODE=/path/to/node`)
and needs Node 22+. It installs dependencies from the npm registry but never
contacts a provider.

## Conventions

- **Commits and PR titles** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.
  Mark breaking changes with `!` and a `BREAKING CHANGE:` footer. Changes to
  commands, options, configuration or exit codes count as breaking.
- **Runtime code must run on Node.js.** Bun is only the development
  toolchain; the build fails if `dist/devzy.js` uses `Bun.*` APIs or imports
  a package that is not in `dependencies`.
- **No secrets in tests.** Tests use stubbed `fetch` and temporary
  directories, and pass an isolated environment explicitly.
- Stdout is for report output; diagnostics go to stderr.

## Adding a provider

See "Adding a provider" in the [README](README.md#adding-a-provider).

## Releases

Maintainers release by tagging; see [RELEASING.md](RELEASING.md).

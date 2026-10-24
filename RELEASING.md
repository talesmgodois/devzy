# Releasing devzy

Releases are **tag-driven**. Pushing a tag `vX.Y.Z` (or `vX.Y.Z-pre.N`) runs
[`.github/workflows/publish.yml`](.github/workflows/publish.yml), which:

1. validates the tag (strict SemVer) and checks that it equals `package.json`
   `version`, that `license` and `repository` are set, and that the version is
   not already on npm;
2. installs with the frozen lockfile, audits dependencies and runs format,
   lint, typecheck and all tests;
3. builds, checks the package contents, packs the tarball, records its
   sha256 and smoke-tests that exact tarball on Node 22;
4. in a separate job with `id-token: write` (only there), verifies the sha256
   and publishes **that tarball** with npm Trusted Publishing (OIDC). No npm
   token is used. Stable versions get the `latest` dist-tag, prereleases
   `next`;
5. checks the version is visible on the registry and creates a GitHub
   release with generated notes and the tarball attached.

## Versioning

[Semantic Versioning](https://semver.org/):

| Change                                                                 | Bump    | Commit type             |
| ---------------------------------------------------------------------- | ------- | ----------------------- |
| Bug fix, no behaviour change for working setups                        | patch   | `fix`, `perf`           |
| New command, option, provider or output that doesn't break scripts     | minor   | `feat`                  |
| Removed/renamed command or option, changed output format, exit codes or configuration schema | major | `feat!`, `fix!`, `BREAKING CHANGE:` |

Prereleases: `npm version prerelease --preid=rc` gives `1.3.0-rc.0`,
published under the `next` dist-tag (`npm install -g devzy@next`).

## One-time setup (maintainer)

Already done in the repository:

- `package.json` has `license: MIT` (with `LICENSE`), `repository`
  (`github.com/talesmgodois/devzy`), `homepage`, `bugs` and `author`. The
  publish workflow refuses to run without `license` and `repository`, because
  provenance and Trusted Publishing depend on the repository URL.
- The GitHub repository is public, so npm can attach provenance.

Still to do, in your GitHub and npm accounts:

1. **Create the GitHub environment** `npm` (repository Settings →
   Environments → New environment) and add yourself as a required reviewer,
   so every publish waits for your approval. GitHub would create the
   environment automatically on the first run, but without that protection.
2. **Make the package exist on npm.** npm configures Trusted Publishing from
   the package's settings page, so a never-published name has nowhere to set
   it. Publish the first version once by hand, from a clean checkout of `main`:

   ```bash
   nvm use 24                       # the smoke test needs Node 22+
   npm login                        # account with 2FA enabled
   bun install --frozen-lockfile && bun run check
   bun scripts/release-check.ts v0.1.0
   npm publish --access public      # prepack builds dist/devzy.js
   git tag v0.1.0 && git push origin v0.1.0   # see below
   ```

   This first version has no provenance. Pushing the `v0.1.0` tag afterwards
   runs the publish workflow, which **stops in `verify`** with "is already
   published". That's expected and harmless; the tag simply marks the release
   in git. Create its GitHub release by hand if you want one
   (`gh release create v0.1.0 --generate-notes`). If npm does let you add a
   trusted publisher before the first publish, skip this step and release
   0.1.0 through the workflow instead.
3. **Configure npm Trusted Publishing**: npmjs.com → package `devzy` →
   Settings → Trusted Publisher → GitHub Actions:
   - Organization or user: `talesmgodois`
   - Repository: `devzy`
   - Workflow filename: `publish.yml`
   - Environment: `npm`

   A new trusted-publisher configuration must complete a successful publish
   within 2 days, or it expires and has to be recreated. Configure it right
   before the first CI release (step 5).
4. **Restrict token publishing**: package Settings → Publishing access →
   "Require two-factor authentication and disallow tokens". Trusted
   Publishing keeps working because it uses OIDC.
5. **First CI release**: follow [Release steps](#release-steps) with the
   next version (e.g. `npm version patch` → `v0.1.1`). Its npm page should
   show a provenance badge.

Trusted Publishing requires npm ≥ 11.5.1 and Node ≥ 22.14; the workflow uses
Node 24 and upgrades npm if needed.

**Provenance:** with Trusted Publishing from a **public** GitHub repository,
npm attaches a provenance attestation automatically. It proves which
repository, workflow and commit built the tarball. It does not prove the
code is free of vulnerabilities, and no provenance is generated for private
repositories.

## Release steps

```bash
git switch main && git pull
bun install --frozen-lockfile
bun run check                       # same checks as CI, including the Node smoke test
npm version minor -m "chore(release): %s"
                                    # or patch | major | prerelease --preid=rc
                                    # creates the commit "chore(release): X.Y.Z" and the tag vX.Y.Z
git push --follow-tags
```

Then:

1. Watch **Actions → Publish** for the tag. Approve the `npm` environment if
   it requires reviewers.
2. Verify:

   ```bash
   npm view devzy@X.Y.Z version dist.attestations
   cd "$(mktemp -d)" && npx --yes devzy@X.Y.Z --version
   ```

3. Edit the generated GitHub release notes if needed. They group pull
   requests and commits; Conventional Commit titles make them readable.

## Troubleshooting

| Symptom                                                        | Fix                                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Tag vX.Y.Z does not match package.json version`               | Delete the tag (`git push --delete origin vX.Y.Z; git tag -d vX.Y.Z`), run `npm version`, push again |
| `is not a release tag`                                         | Tags must be `vMAJOR.MINOR.PATCH[-pre]`, no build metadata                                    |
| `is already published`                                         | npm versions are immutable; bump to the next version                                          |
| `package.json has no "license"` / `"repository"`               | Complete step 1 of the one-time setup                                                         |
| `npm publish` fails with `E404`/`ENEEDAUTH`/OIDC errors        | Trusted Publisher fields must match exactly: owner, repository, `publish.yml`, environment `npm`; the repository URL in `package.json` must match the GitHub repository |
| Provenance error mentioning a private repository              | Provenance needs a public repository; make it public or publish without provenance (document the decision) |
| Smoke test fails on the tarball                                | Reproduce locally: `bun run build && bun scripts/smoke.ts`                                    |

Do not re-run a failed release by moving a tag to a different commit.
Publish a new version instead.

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

These cannot be done from the code and **must be done before the first release**:

1. **Fill in package metadata** in `package.json`: `license` (and add a
   matching `LICENSE` file), `repository`
   (`{ "type": "git", "url": "git+https://github.com/<owner>/devzy.git" }`),
   and optionally `homepage` and `bugs`. The publish workflow refuses to run
   without `license` and `repository`, because provenance and Trusted
   Publishing depend on the repository URL.
2. **Create the GitHub environment** `npm` (Settings → Environments). Add
   required reviewers if releases should need manual approval.
3. **Configure npm Trusted Publishing** on npmjs.com → package `devzy` →
   Settings → Trusted Publisher → GitHub Actions:
   - Organization or user: `<owner>`
   - Repository: `devzy`
   - Workflow filename: `publish.yml`
   - Environment: `npm`

   A new trusted-publisher configuration must complete a successful publish
   within 2 days or it expires and has to be recreated. If npm doesn't let
   you add a trusted publisher before the package exists, publish the first
   version once manually (`npm publish` from a clean `bun run check`ed
   checkout, with 2FA), then configure the trusted publisher and use tags
   from then on.
4. **Restrict token publishing**: package Settings → Publishing access →
   "Require two-factor authentication and disallow tokens". Trusted
   Publishing keeps working because it uses OIDC.

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

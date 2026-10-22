/**
 * Validates a release before publishing (used by .github/workflows/publish.yml).
 *
 *   bun scripts/release-check.ts <tag> [--skip-registry]
 *
 * - The tag must be strict SemVer with a "v" prefix (no build metadata).
 * - The tag (minus "v") must equal package.json "version".
 * - package.json must declare "license" and "repository" (npm provenance and
 *   Trusted Publishing need a correct repository URL).
 * - The version must not already exist on npm (versions are never overwritten).
 * - Prereleases publish under the "next" dist-tag, others under "latest".
 *
 * Writes version, dist_tag and name to $GITHUB_OUTPUT when it is set.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const IDENT = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_TAG = new RegExp(
  `^v(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENT}(?:\\.${IDENT})*))?$`,
);

export interface PackageMeta {
  name?: string;
  version?: string;
  license?: string;
  repository?: string | { url?: string };
}

export interface ReleasePlan {
  name: string;
  version: string;
  distTag: "latest" | "next";
}

/** Pure validation; returns the plan or the list of problems. */
export function validateRelease(
  tag: string,
  pkg: PackageMeta,
): { plan?: ReleasePlan; errors: string[] } {
  const errors: string[] = [];
  const match = SEMVER_TAG.exec(tag);
  if (!match)
    errors.push(
      `Tag "${tag}" is not a release tag: expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-prerelease.`,
    );
  const tagVersion = tag.replace(/^v/, "");
  if (!pkg.version) errors.push('package.json has no "version".');
  else if (match && pkg.version !== tagVersion) {
    errors.push(
      `Tag ${tag} does not match package.json version ${pkg.version}. Bump with \`npm version\` and re-tag.`,
    );
  }
  if (!pkg.name) errors.push('package.json has no "name".');
  if (!pkg.license)
    errors.push('package.json has no "license"; the maintainer must choose one before publishing.');
  const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!repoUrl) {
    errors.push(
      'package.json has no "repository"; npm provenance and Trusted Publishing need the GitHub repository URL.',
    );
  }
  if (errors.length > 0 || !pkg.name || !pkg.version) return { errors };
  return {
    plan: { name: pkg.name, version: pkg.version, distTag: match?.[4] ? "next" : "latest" },
    errors,
  };
}

/** True if name@version is already on the registry; throws if that cannot be determined. */
export function isPublished(name: string, version: string): boolean {
  const view = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (view.status === 0) return view.stdout.trim() !== "";
  if (/E404|404 Not Found/.test(view.stderr)) return false;
  throw new Error(
    `Could not query the npm registry for ${name}@${version}:\n${view.stderr.trim()}`,
  );
}

if (import.meta.main) {
  const [tag, flag] = process.argv.slice(2);
  if (!tag) {
    console.error("usage: bun scripts/release-check.ts <tag> [--skip-registry]");
    process.exit(2);
  }
  const root = resolve(import.meta.dir, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageMeta;
  const { plan, errors } = validateRelease(tag, pkg);
  if (!plan) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  if (flag !== "--skip-registry" && isPublished(plan.name, plan.version)) {
    console.error(
      `::error::${plan.name}@${plan.version} is already published; npm versions cannot be overwritten.`,
    );
    process.exit(1);
  }
  console.log(`Release OK: ${plan.name}@${plan.version} -> dist-tag "${plan.distTag}"`);
  const output = process.env["GITHUB_OUTPUT"];
  if (output) {
    appendFileSync(
      output,
      `name=${plan.name}\nversion=${plan.version}\ndist_tag=${plan.distTag}\n`,
    );
  }
}

import { describe, expect, test } from "bun:test";
import { validateRelease } from "../../../scripts/release-check.ts";

const pkg = {
  name: "devzy",
  version: "1.2.3",
  license: "MIT",
  repository: { url: "git+https://github.com/owner/devzy.git" },
};

describe("validateRelease", () => {
  test("accepts a matching stable tag for the latest dist-tag", () => {
    expect(validateRelease("v1.2.3", pkg)).toEqual({
      plan: { name: "devzy", version: "1.2.3", distTag: "latest" },
      errors: [],
    });
  });

  test("prereleases go to the next dist-tag", () => {
    expect(validateRelease("v2.0.0-rc.1", { ...pkg, version: "2.0.0-rc.1" }).plan?.distTag).toBe(
      "next",
    );
  });

  test.each([
    "1.2.3",
    "v1.2",
    "v1.2.3.4",
    "v01.2.3",
    "v1.2.3+build.5",
    "v1.2.3-",
    "release-1.2.3",
    "v1.2.3-rc..1",
  ])("rejects malformed tag %p", (tag) => {
    const result = validateRelease(tag, pkg);
    expect(result.plan).toBeUndefined();
    expect(result.errors.join("\n")).toContain("is not a release tag");
  });

  test("rejects a tag that does not match package.json", () => {
    expect(validateRelease("v1.2.4", pkg).errors).toEqual([
      "Tag v1.2.4 does not match package.json version 1.2.3. Bump with `npm version` and re-tag.",
    ]);
  });

  test("requires license and repository metadata", () => {
    const errors = validateRelease("v1.2.3", { name: "devzy", version: "1.2.3" }).errors.join("\n");
    expect(errors).toContain('no "license"');
    expect(errors).toContain('no "repository"');
    expect(validateRelease("v1.2.3", { ...pkg, repository: "github:owner/devzy" }).errors).toEqual(
      [],
    );
  });
});

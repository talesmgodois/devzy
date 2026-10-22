import { describe, expect, test } from "bun:test";
import { describeFilters, FilterError, parseFilters } from "../../domain/filters.ts";

describe("parseFilters", () => {
  test("no values yields empty filters", () => {
    expect(parseFilters("git", {})).toEqual({
      emails: [],
      providers: [],
      repositories: [],
      statuses: [],
    });
  });

  test("normalizes and de-duplicates repeated values", () => {
    const f = parseFilters("all", {
      email: ["  Dev@Example.com ", "dev@example.com", "other@example.com"],
      provider: ["GitHub", "jira"],
    });
    expect(f.emails).toEqual(["dev@example.com", "other@example.com"]);
    expect(f.providers).toEqual(["github", "jira"]);
  });

  test("repo and status are parsed for the reports they apply to", () => {
    expect(parseFilters("git", { repo: ["Acme/API", "group/sub/project"] }).repositories).toEqual([
      "acme/api",
      "group/sub/project",
    ]);
    expect(
      parseFilters("tasks", { status: ["completed", "in-review", "IN_PROGRESS"] }).statuses,
    ).toEqual(["completed", "in_review", "in_progress"]);
  });

  test.each([
    ["tasks", "repo", "acme/api"],
    ["all", "repo", "acme/api"],
    ["git", "status", "completed"],
    ["all", "status", "completed"],
  ] as const)("rejects incompatible filter: pm %s --%s", (kind, flag, value) => {
    expect(() => parseFilters(kind, { [flag]: [value] })).toThrow(/cannot be used with devzy pm/);
  });

  test.each([
    ["email", "not-an-email"],
    ["email", "a b@example.com"],
    ["repo", "just-a-name"],
    ["repo", "acme/"],
    ["status", "done"],
    ["provider", "bad id!"],
  ])("rejects invalid --%s %p", (flag, value) => {
    const kind = flag === "status" ? "tasks" : "git";
    expect(() => parseFilters(kind, { [flag]: [value] })).toThrow(FilterError);
  });

  test("describeFilters lists active filters only", () => {
    const f = parseFilters("git", {
      provider: ["github"],
      email: ["a@example.com", "b@example.com"],
    });
    expect(describeFilters(f)).toEqual([
      "email = a@example.com | b@example.com",
      "provider = github",
    ]);
  });
});

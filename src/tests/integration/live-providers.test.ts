import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfigText } from "../../services/config/load.ts";
import type { FetchLike } from "../../services/providers/adapter.ts";
import { isolatedEnv, makeTempDir, runInProcess, writeText } from "../helpers.ts";
import { json, status, stubFetch } from "../http-stub.ts";

const TOKENS = {
  GITHUB_TOKEN: "ghp_livegithubtoken0000000000000000000",
  GITLAB_TOKEN: "glpat-livegitlabtoken000000000",
  JIRA_API_TOKEN: "ATATT3xFfGF0-livejiratoken-0000",
  OPENPROJECT_API_KEY: "op-live-key-0000000000000000000000",
};

const CONFIG = `providers:
  - id: gh-live
    type: github
    name: GitHub
    mode: live
    options: { repositories: [acme/api] }
  - id: gl-live
    type: gitlab
    name: GitLab
    mode: live
    options: { baseUrl: "https://gitlab.example.com", projects: [acme/infra] }
  - id: jira-live
    type: jira
    name: Jira
    mode: live
    options: { baseUrl: "https://acme.atlassian.net", email: "bot@example.com", projects: [ENG] }
  - id: op-live
    type: openproject
    name: OpenProject
    mode: live
    options: { baseUrl: "https://pm.example.com", projects: [website] }
identities:
  - id: ana
    name: Ana Souza
    emails: [ana@example.com]
    accounts: [{ provider: jira-live, userId: acc-ana }]
  - id: ben
    name: Ben Carter
    emails: [ben@example.com]
    accounts: [{ provider: op-live, userId: "7" }]
`;

const RANGE = ["--dt-since", "2026-01-01", "--dt-to", "2026-01-31"];

/** One fake backend per host; `failing` hosts answer 500. */
function backend(failing: string[] = []) {
  return stubFetch((url) => {
    if (failing.includes(url.host)) return status(500);
    switch (url.host) {
      case "api.github.com":
        if (url.pathname === "/user") return json({ login: "octo" });
        if (url.pathname === "/repos/acme/api") return json({});
        return json([
          ...Array.from({ length: 3 }, () => ({
            author: { id: 1, login: "asouza" },
            commit: {
              author: { name: "Ana Souza", email: "ana@example.com", date: "2026-01-10T00:00:00Z" },
              committer: { date: "2026-01-10T00:00:00Z" },
            },
          })),
          {
            author: { id: 2, login: "bcarter" },
            commit: {
              author: {
                name: "Ben Carter",
                email: "ben@example.com",
                date: "2026-01-11T00:00:00Z",
              },
              committer: { date: "2026-01-11T00:00:00Z" },
            },
          },
        ]);
      case "gitlab.example.com":
        if (url.pathname === "/api/v4/user") return json({ username: "ana" });
        if (url.pathname === "/api/v4/projects/acme%2Finfra")
          return json({ path_with_namespace: "acme/infra" });
        return json(
          [
            {
              author_name: "Ana S.",
              author_email: "ANA@example.com",
              committed_date: "2026-01-12T00:00:00Z",
            },
            {
              author_name: "Farah",
              author_email: "farah@example.com",
              committed_date: "2026-01-12T00:00:00Z",
            },
          ],
          { headers: { "x-next-page": "" } },
        );
      case "acme.atlassian.net":
        if (url.pathname.endsWith("/myself"))
          return json({ accountId: "acc-bot", displayName: "Bot" });
        if (url.pathname.endsWith("/project/ENG")) return json({ key: "ENG" });
        return json({
          isLast: true,
          issues: [
            {
              fields: {
                assignee: { accountId: "acc-ana", displayName: "Ana" },
                status: { name: "Done" },
                statuscategorychangedate: "2026-01-05T00:00:00.000+0000",
              },
            },
            {
              fields: {
                assignee: { accountId: "acc-ana", displayName: "Ana" },
                status: { name: "In Review" },
                statuscategorychangedate: "2026-01-06T00:00:00.000+0000",
              },
            },
            {
              fields: {
                assignee: null,
                status: { name: "Done" },
                statuscategorychangedate: "2026-01-06T00:00:00.000+0000",
              },
            },
          ],
        });
      case "pm.example.com":
        if (url.pathname.endsWith("/users/me")) return json({ id: 1, login: "devzy" });
        if (url.pathname === "/api/v3/projects/website") return json({ id: 3 });
        return json({
          total: 2,
          pageSize: 100,
          _embedded: {
            elements: [
              {
                id: 1,
                updatedAt: "2026-01-07T00:00:00Z",
                _links: {
                  status: { title: "Closed" },
                  assignee: { href: "/api/v3/users/7", title: "Ben C." },
                },
              },
              {
                id: 2,
                updatedAt: "2026-01-08T00:00:00Z",
                _links: {
                  status: { title: "In progress" },
                  assignee: { href: "/api/v3/users/7", title: "Ben C." },
                },
              },
            ],
          },
        });
      default:
        throw new Error(`unexpected host ${url.host}`);
    }
  });
}

let dir: string;
let cleanup: () => Promise<void>;
let env: Record<string, string>;
const configPath = () => join(dir, "devzy.yaml");

beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir());
  env = isolatedEnv(join(dir, "home"), { ...TOKENS, DEVZY_CONFIG_PATH: join(dir, "devzy.yaml") });
  await writeText(configPath(), CONFIG);
});
afterEach(() => cleanup());

const cli = (args: string[], fetch: FetchLike) =>
  runInProcess(args, { cwd: dir, env, deps: { fetch } });

function rowOf(stdout: string, name: string): string {
  return stdout.split("\n").find((l) => l.includes(name)) ?? "";
}

function expectNoSecrets(text: string): void {
  for (const token of Object.values(TOKENS)) expect(text).not.toContain(token);
}

describe("live providers end to end (stubbed HTTP)", () => {
  test("pm git aggregates live GitHub and GitLab", async () => {
    const { fetch } = backend();
    const r = await cli(["pm", "git", ...RANGE], fetch);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Sources: gh-live (live), gl-live (live)");
    expect(r.stdout).not.toContain("MOCK DATA");
    expect(rowOf(r.stdout, "Ana Souza")).toMatch(/mapped\s+4\s+2\s+gh-live, gl-live/);
    expect(rowOf(r.stdout, "Farah")).toMatch(/email\s+1\s+1\s+gl-live/);
    expectNoSecrets(r.stdout + r.stderr);
  });

  test("pm tasks aggregates live Jira and OpenProject with notes", async () => {
    const { fetch } = backend();
    const r = await cli(["pm", "tasks", ...RANGE], fetch);
    expect(r.code).toBe(0);
    expect(rowOf(r.stdout, "Ana Souza")).toMatch(/mapped\s+1\s+0\s+1\s+jira-live/);
    expect(rowOf(r.stdout, "Ben Carter")).toMatch(/mapped\s+1\s+1\s+0\s+op-live/);
    expect(r.stdout).toContain("jira-live: excluded 1 task(s) without an assignee.");
  });

  test("pm all joins a GitLab email and a Jira accountId through one identity", async () => {
    const { fetch } = backend();
    const r = await cli(["pm", "all", ...RANGE], fetch);
    expect(r.code).toBe(0);
    expect(rowOf(r.stdout, "Ana Souza")).toMatch(
      /mapped\s+4\s+1\s+0\s+1\s+gh-live, gl-live, jira-live/,
    );
    expect(rowOf(r.stdout, "Ben Carter")).toMatch(/mapped\s+1\s+1\s+1\s+0\s+gh-live, op-live/);
    expect(r.stdout.split("\n").filter((l) => l.includes("Ana"))).toHaveLength(1);
  });

  test("filters: --provider, --repo and --status", async () => {
    const { fetch, calls } = backend();
    const git = await cli(
      ["pm", "git", ...RANGE, "--provider", "gitlab", "--repo", "acme/infra"],
      fetch,
    );
    expect(git.code).toBe(0);
    expect(git.stdout).toContain("Sources: gl-live (live)");
    expect(calls.every((c) => c.url.host === "gitlab.example.com")).toBe(true);

    const tasks = await cli(["pm", "tasks", ...RANGE, "--status", "completed"], fetch);
    expect(rowOf(tasks.stdout, "Ben Carter")).toMatch(/mapped\s+1\s+-\s+-\s+op-live/);
    expect(rowOf(tasks.stdout, "Ana Souza")).toMatch(/mapped\s+1\s+-\s+-\s+jira-live/);
  });

  test("a failing live provider makes the report partial, never zero", async () => {
    const { fetch } = backend(["pm.example.com"]);
    const r = await cli(["pm", "tasks", ...RANGE], fetch);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("PARTIAL REPORT: 1 of 2 providers failed (op-live)");
    expect(r.stderr).toContain("provider op-live (OpenProject) failed: OpenProject server error");
    expect(r.stdout).not.toContain("Ben Carter");
    expectNoSecrets(r.stdout + r.stderr);
  });

  test("health covers all four live providers", async () => {
    const { fetch } = backend();
    const r = await cli(["health"], fetch);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Summary: 4 healthy");
    expect(r.stdout).toMatch(
      /gl-live\s+GitLab\s+git\s+live\s+healthy\s+Authenticated as ana; 1\/1 projects accessible\./,
    );
    expect(r.stdout).toMatch(/jira-live\s+Jira\s+tasks\s+live\s+healthy/);
    expect(r.stdout).toMatch(/op-live\s+OpenProject\s+tasks\s+live\s+healthy/);

    const failing = await cli(["health"], backend(["acme.atlassian.net"]).fetch);
    expect(failing.code).toBe(3);
    expect(failing.stdout).toMatch(/jira-live\s+Jira\s+tasks\s+live\s+error\s+Jira server error/);
  });

  test("providers list shows availability and credential sources", async () => {
    const r = await cli(["providers"], backend().fetch);
    expect(r.stdout).toMatch(/gitlab\s+GitLab\s+git\s+available\s+available/);
    expect(r.stdout).toMatch(/jira\s+Jira\s+tasks\s+available\s+available/);
    expect(r.stdout).toMatch(/openproject\s+OpenProject\s+tasks\s+not implemented\s+available/);
    expect(r.stdout).toContain("$JIRA_API_TOKEN (set)");
    expectNoSecrets(r.stdout);
  });
});

describe("providers add for the new live types (non-interactive)", () => {
  const add = (args: string[]) =>
    runInProcess(["providers", "add", "--non-interactive", ...args], {
      cwd: dir,
      env,
      deps: { fetch: backend().fetch },
    });

  test("adds gitlab, jira and openproject entries with only the token variable name", async () => {
    const results = [
      await add([
        "--type",
        "gitlab",
        "--mode",
        "live",
        "--id",
        "gl-2",
        "--project",
        "grp/sub/proj",
        "--token-env",
        "GL2_TOKEN",
      ]),
      await add([
        "--type",
        "jira",
        "--mode",
        "live",
        "--id",
        "jira-2",
        "--base-url",
        "https://other.atlassian.net",
        "--account-email",
        "me@example.com",
        "--project",
        "OPS",
        "--token-env",
        "JIRA2_TOKEN",
      ]),
      await add([
        "--type",
        "openproject",
        "--mode",
        "live",
        "--id",
        "op-2",
        "--base-url",
        "https://op2.example.com",
        "--project",
        "intranet",
        "--token-env",
        "OP2_TOKEN",
      ]),
    ];
    for (const r of results) expect(r.code).toBe(0);
    const text = await readFile(configPath(), "utf8");
    expectNoSecrets(text);
    const providers = parseConfigText(text, "x").providers ?? [];
    expect(providers.slice(-3).map((p) => [p.id, p.options, p.credentials])).toEqual([
      [
        "gl-2",
        { projects: ["grp/sub/proj"], baseUrl: "https://gitlab.com" },
        { tokenEnv: "GL2_TOKEN" },
      ],
      [
        "jira-2",
        { baseUrl: "https://other.atlassian.net", email: "me@example.com", projects: ["OPS"] },
        { tokenEnv: "JIRA2_TOKEN" },
      ],
      [
        "op-2",
        { baseUrl: "https://op2.example.com", projects: ["intranet"] },
        { tokenEnv: "OP2_TOKEN" },
      ],
    ]);
  });

  test("reports missing required values and inapplicable flags", async () => {
    const jira = await add(["--type", "jira", "--mode", "live", "--id", "j3", "--project", "ENG"]);
    expect(jira.code).toBe(2);
    expect(jira.stderr).toContain(
      "Missing required option(s) for a live jira provider: --base-url, --account-email",
    );
    const op = await add([
      "--type",
      "openproject",
      "--mode",
      "live",
      "--id",
      "o3",
      "--base-url",
      "https://x.example.com",
      "--account-email",
      "a@b.co",
    ]);
    expect(op.code).toBe(2);
    expect(op.stderr).toContain("--account-email does not apply");
    const mock = await add([
      "--type",
      "gitlab",
      "--mode",
      "mock",
      "--id",
      "g3",
      "--project",
      "a/b",
    ]);
    expect(mock.code).toBe(2);
    expect(mock.stderr).toContain("--project does not apply to a mock adapter");
  });
});

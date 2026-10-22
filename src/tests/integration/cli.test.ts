import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isolatedEnv, makeTempDir, SEPTEMBER, spawnCli, writeText } from "../helpers.ts";

// These tests spawn the CLI several times each; 5 s is too tight on busy machines and CI runners.
setDefaultTimeout(30_000);

let dir: string;
let cleanup: () => Promise<void>;
let home: string;
let cwd: string;
let env: Record<string, string>;

beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir());
  home = join(dir, "home");
  cwd = join(dir, "work");
  await writeText(join(cwd, ".keep"), "");
  env = isolatedEnv(home);
});
afterEach(() => cleanup());

const cli = (args: string[], extraEnv: Record<string, string> = {}) =>
  spawnCli(args, { cwd, env: { ...env, ...extraEnv } });
const userConfig = () => join(home, ".config", "devzy", "config.yaml");

describe("help routes", () => {
  test.each([
    [["help"], "Usage:\n  devzy <command>"],
    [["--help"], "Usage:\n  devzy <command>"],
    [[], "Usage:\n  devzy <command>"],
    [["help", "pm"], "Usage: devzy pm <git|tasks|all>"],
    [["pm", "help"], "Usage: devzy pm <git|tasks|all>"],
    [["pm", "--help"], "Usage: devzy pm <git|tasks|all>"],
    [["pm", "git", "--help"], "Usage: devzy pm git"],
    [["pm", "tasks", "-h"], "Usage: devzy pm tasks"],
    [["pm", "all", "--help"], "Usage: devzy pm all"],
    [["providers", "help"], "Usage: devzy providers <list|add>"],
    [["providers", "add", "--help"], "Usage: devzy providers add"],
    [["health", "help"], "Usage: devzy health [show]"],
    [["health", "show", "--help"], "Usage: devzy health show"],
  ])("devzy %p prints help to stdout", async (args, expected) => {
    const r = await cli(args);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(expected);
    expect(r.stderr).toBe("");
  });

  test("report help documents filters, dates and repeat semantics", async () => {
    const r = await cli(["pm", "git", "--help"]);
    for (const text of [
      "--dt-since",
      "--dt-to",
      "--email",
      "--provider",
      "--repo",
      "(OR)",
      "(AND)",
      "UTC",
    ]) {
      expect(r.stdout).toContain(text);
    }
    expect(r.stdout).not.toContain("--status <status>  ");
  });

  test("--version", async () => {
    const pkg = (await Bun.file(join(import.meta.dir, "../../../package.json")).json()) as {
      version: string;
    };
    expect((await cli(["--version"])).stdout.trim()).toBe(pkg.version);
  });
});

describe("invalid usage", () => {
  test.each([
    [["frob"], /Unknown command "frob"/],
    [["pm"], /needs a subcommand/],
    [["pm", "nope"], /Unknown command "devzy pm nope"/],
    [["pm", "git", "--bogus"], /Unknown option '--bogus'/],
    [["pm", "git", "extra"], /Unexpected argument 'extra'/],
    [["pm", "git", "--dt-since", "2026-13-01"], /not a valid calendar date/],
    [["pm", "git", "--dt-since", "2026-02-01", "--dt-to", "2026-01-01"], /must not be later/],
    [["pm", "git", "--dt-since", "2026-01-01", "--dt-since", "2026-01-02"], /only once/],
    [["pm", "tasks", "--repo", "acme/api"], /--repo cannot be used with devzy pm tasks/],
    [["pm", "git", "--status", "completed"], /--status cannot be used with devzy pm git/],
    [["pm", "all", "--repo", "acme/api"], /--repo cannot be used with devzy pm all/],
    [["pm", "git", "--provider", "jira"], /refers to tasks providers/],
    [["pm", "git", "--provider", "missing"], /does not match any configured provider/],
    [["pm", "git", "--email", "nope"], /expects an email address/],
    [["pm", "tasks", "--sort", "commits"], /--sort for pm tasks must be one of/],
    [["health", "--timeout", "abc"], /--timeout must be/],
  ])("devzy %p exits 2 with an error on stderr", async (args, pattern) => {
    const r = await cli(args);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(pattern);
    expect(r.stderr).toMatch(/Run "devzy .*" for usage\./);
  });
});

describe("reports in mock mode (fresh install, no config)", () => {
  test.each([
    [["pm", "git"], "Git activity", "Commits"],
    [["pm", "tasks"], "Task activity", "In review / testing"],
    [["pm", "all"], "Combined activity", "Commits"],
  ])("devzy %p", async (args, title, column) => {
    const r = await cli([...args, ...SEPTEMBER]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${title}: 2026-09-01 to 2026-09-30 (inclusive, UTC)`);
    expect(r.stdout).toContain("MOCK DATA");
    expect(r.stdout).toContain(column);
    expect(r.stderr).toContain("built-in mock demo configuration");
    expect(r.stderr).not.toContain("error");
  });

  test("output is deterministic", async () => {
    const a = await cli(["pm", "all", ...SEPTEMBER]);
    const b = await cli(["pm", "all", ...SEPTEMBER]);
    expect(a.stdout).toBe(b.stdout);
  });

  test("default period is the last 30 days ending today", async () => {
    const r = await cli(["pm", "git"]);
    const today = new Date().toISOString().slice(0, 10);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`to ${today} (inclusive, UTC; default period)`);
  });

  test("filters are shown in the header and applied", async () => {
    const r = await cli([
      "pm",
      "git",
      ...SEPTEMBER,
      "--provider",
      "github",
      "--repo",
      "acme/web",
      "--email",
      "Ana.Souza@example.com",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "Filters: email = ana.souza@example.com; provider = github; repo = acme/web",
    );
    expect(r.stdout).toContain("Sources: github-demo (mock)");
    expect(r.stdout).toContain("Ana Souza");
    expect(r.stdout).not.toContain("Ben Carter");
  });

  test("identity mapping joins a provider account without email; unmatched stays separate", async () => {
    const r = await cli(["pm", "all", ...SEPTEMBER]);
    const lines = r.stdout.split("\n");
    expect(lines.filter((l) => l.includes("Dana Okafor"))).toHaveLength(1);
    expect(lines.find((l) => l.includes("Dana Okafor"))).toContain("mapped");
    expect(lines.filter((l) => / Sam Lee /.test(l))).toHaveLength(2);
    expect(r.stdout).toMatch(/Ivo Petrov\s+unmapped/);
  });

  test("email filter on tasks notes rows that cannot be checked", async () => {
    const r = await cli(["pm", "tasks", ...SEPTEMBER, "--email", "dana.okafor@example.com"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Dana Okafor");
    expect(r.stdout).toMatch(
      /jira-demo: excluded \d+ task row\(s\) with no email and no identity mapping/,
    );
  });

  test("status filter shows '-' for buckets that were filtered out", async () => {
    const r = await cli(["pm", "tasks", ...SEPTEMBER, "--status", "completed"]);
    expect(r.code).toBe(0);
    const anaLine = r.stdout.split("\n").find((l) => l.includes("Ana Souza")) ?? "";
    expect(anaLine).toMatch(/\d+\s+-\s+-\s/);
  });

  test("empty filtered result prints a useful message", async () => {
    const r = await cli(["pm", "git", ...SEPTEMBER, "--email", "nobody@example.com"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "No Git activity found between 2026-09-01 and 2026-09-30 matching the active filters.",
    );
    expect(r.stdout).not.toContain("Contributor");
  });

  test("--quiet keeps stderr clean", async () => {
    const r = await cli(["pm", "git", ...SEPTEMBER, "--quiet"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });
});

describe("providers and health in mock mode", () => {
  test("devzy providers (alias of list)", async () => {
    const a = await cli(["providers"]);
    const b = await cli(["providers", "list"]);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("Known provider types");
    expect(a.stdout).toMatch(/bitbucket\s+Bitbucket\s+git\s+not implemented\s+not implemented/);
    expect(a.stdout).toMatch(/github\s+GitHub\s+git\s+available\s+available/);
    expect(a.stdout).toContain("Configured git providers");
    expect(a.stdout).toContain("Configured tasks providers");
  });

  test("devzy health (alias of show)", async () => {
    const a = await cli(["health"]);
    const b = await cli(["health", "show"]);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("Summary: 4 healthy");
  });
});

describe("configuration errors", () => {
  test("malformed YAML exits 4 with the path", async () => {
    await writeText(userConfig(), "providers: [\n");
    const r = await cli(["pm", "git"]);
    expect(r.code).toBe(4);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`Malformed YAML in ${userConfig()}`);
  });

  test("invalid schema exits 4 with field paths", async () => {
    await writeText(
      userConfig(),
      "providers:\n  - id: x\n    type: github\n    name: X\n    mode: sometimes\n",
    );
    const r = await cli(["providers"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("providers[0].mode");
  });

  test("missing DEVZY_CONFIG_PATH file exits 4", async () => {
    const r = await cli(["pm", "git"], { DEVZY_CONFIG_PATH: join(dir, "nope.yaml") });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("Configuration file not found");
  });

  test("no enabled providers of a category exits 1 with guidance", async () => {
    await writeText(
      userConfig(),
      "providers:\n  - id: j\n    type: jira\n    name: J\n    mode: mock\n",
    );
    const r = await cli(["pm", "git"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No enabled Git providers are configured");
  });
});

describe("partial failures and secrets", () => {
  const CONFIG = `providers:
  - id: gh
    type: github
    name: GitHub mock
    mode: mock
  - id: gl-broken
    type: gitlab
    name: Broken GitLab
    mode: mock
    options: { failReports: true, health: error }
  - id: jira
    type: jira
    name: Jira
    mode: mock
    options: { health: unhealthy }
`;

  test("one failing provider: partial report, exit 3, failure on stderr", async () => {
    await writeText(userConfig(), CONFIG);
    const r = await cli(["pm", "git", ...SEPTEMBER]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("PARTIAL REPORT: 1 of 2 providers failed (gl-broken)");
    expect(r.stdout).toContain("Ana Souza");
    expect(r.stderr).toContain(
      "error: provider gl-broken (Broken GitLab) failed: Simulated failure",
    );
  });

  test("all selected providers failing exits 1 without a table", async () => {
    await writeText(userConfig(), CONFIG);
    const r = await cli(["pm", "git", ...SEPTEMBER, "--provider", "gl-broken"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Every selected provider failed");
  });

  test("health: failing checks exit 3 and are listed with their status", async () => {
    await writeText(userConfig(), CONFIG);
    const r = await cli(["health"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/gl-broken\s+Broken GitLab\s+git\s+mock\s+error/);
    expect(r.stdout).toMatch(/jira\s+Jira\s+tasks\s+mock\s+unhealthy/);
    expect(r.stdout).toContain("Summary: 1 healthy, 1 unhealthy, 1 error");
  });

  test("health: timeouts are reported per provider", async () => {
    await writeText(
      userConfig(),
      `providers:\n  - id: slow\n    type: linear\n    name: Slow\n    mode: mock\n    options: { health: timeout }\n`,
    );
    const r = await cli(["health", "--timeout", "200"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("No response within 200 ms.");
  });

  test("live provider errors never print the token", async () => {
    const token = "ghp_DoNotPrintThisTokenAnywhere123456";
    await writeText(
      userConfig(),
      `providers:\n  - id: gh-live\n    type: github\n    name: GH live\n    mode: live\n    options: { repositories: [acme/api], baseUrl: "http://127.0.0.1:9" }\n    credentials: { tokenEnv: MY_GH }\n`,
    );
    const env2 = { MY_GH: token, DEVZY_REQUEST_TIMEOUT_MS: "2000" };
    for (const args of [["pm", "git", ...SEPTEMBER], ["health"], ["providers"]]) {
      const r = await cli(args, env2);
      expect(r.stdout + r.stderr).not.toContain(token);
    }
    const list = await cli(["providers"], env2);
    expect(list.stdout).toContain("$MY_GH (set)");
    const report = await cli(["pm", "git", ...SEPTEMBER], env2);
    expect(report.code).toBe(1);
    expect(report.stderr).toContain("Could not reach GitHub");
  });

  test("mixing mock and live providers is refused unless allowed", async () => {
    await writeText(
      userConfig(),
      `providers:\n  - id: gh\n    type: github\n    name: GH\n    mode: mock\n  - id: gh-live\n    type: github\n    name: GH live\n    mode: live\n    options: { repositories: [acme/api] }\n`,
    );
    const r = await cli(["pm", "git", ...SEPTEMBER]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mix mock and live data");
    const allowed = await cli(["pm", "git", ...SEPTEMBER, "--allow-mixed-modes"]);
    expect(allowed.code).toBe(3); // live provider has no token -> partial
    expect(allowed.stdout).toContain("Sources: gh (mock), gh-live (live)");
    expect(allowed.stdout).toContain("Data from sources marked (mock)");
    expect(allowed.stderr).toContain("Missing credentials");
  });
});

describe("providers add (non-interactive)", () => {
  test("missing values are reported, nothing is written", async () => {
    const r = await cli(["providers", "add", "--type", "github"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Missing required option(s) for non-interactive mode: --mode, --id");
    expect(await Bun.file(userConfig()).exists()).toBe(false);
  });

  test("adds providers while preserving unrelated configuration", async () => {
    await writeText(
      userConfig(),
      "# team config\nsettings:\n  defaultPeriodDays: 14\nproviders:\n  - id: jira\n    type: jira\n    name: Jira\n    mode: mock\n",
    );
    const r = await cli(["providers", "add", "--type", "github", "--mode", "mock", "--id", "gh"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Saved provider "gh" (github, mock) to ${userConfig()}.`);
    const text = await readFile(userConfig(), "utf8");
    expect(text).toContain("# team config");
    expect(text).toContain("defaultPeriodDays: 14");
    expect(text).toMatch(/- id: jira[\s\S]*- id: gh/);

    const list = await cli(["providers"]);
    expect(list.stdout).toMatch(/gh\s+GitHub \(mock\)\s+github\s+yes\s+mock\s+available/);
  });

  test("live GitHub stores only the token variable name", async () => {
    const r = await cli(
      [
        "providers",
        "add",
        "--type",
        "github",
        "--mode",
        "live",
        "--id",
        "gh-acme",
        "--repo",
        "acme/api",
        "--token-env",
        "ACME_GH",
      ],
      { ACME_GH: "ghp_secretvalue00000000000000000000" },
    );
    expect(r.code).toBe(0);
    const text = await readFile(userConfig(), "utf8");
    expect(text).toContain("tokenEnv: ACME_GH");
    expect(text).not.toContain("ghp_secretvalue");
  });

  test("validation errors and unsupported types do not write", async () => {
    const cases: [string[], number, RegExp][] = [
      [
        ["--type", "github", "--mode", "live", "--id", "gh"],
        2,
        /Missing required option\(s\) for a live github provider: --repo/,
      ],
      [
        ["--type", "github", "--mode", "live", "--id", "gh", "--repo", "bad"],
        2,
        /must be owner\/name/,
      ],
      [["--type", "github", "--mode", "mock", "--id", "Bad ID"], 2, /Invalid --id/],
      [
        ["--type", "github", "--mode", "mock", "--id", "gh", "--repo", "acme/api"],
        2,
        /--repo does not apply/,
      ],
      [
        ["--type", "clickup", "--mode", "mock", "--id", "cu"],
        1,
        /no adapter for it.*Nothing was saved/,
      ],
      [
        ["--type", "linear", "--mode", "live", "--id", "l"],
        1,
        /no live adapter.*Nothing was saved/,
      ],
      [["--type", "nope", "--mode", "mock", "--id", "x"], 2, /Unknown provider type "nope"/],
    ];
    for (const [args, code, pattern] of cases) {
      const r = await cli(["providers", "add", ...args]);
      expect(r.code).toBe(code);
      expect(r.stderr).toMatch(pattern);
    }
    expect(await Bun.file(userConfig()).exists()).toBe(false);
  });

  test("duplicate IDs are rejected", async () => {
    await cli(["providers", "add", "--type", "github", "--mode", "mock", "--id", "gh"]);
    const r = await cli(["providers", "add", "--type", "gitlab", "--mode", "mock", "--id", "gh"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('A provider with ID "gh" already exists');
  });

  test("--scope project writes ./devzy.yaml; DEVZY_CONFIG_PATH is honoured", async () => {
    const r = await cli([
      "providers",
      "add",
      "--type",
      "jira",
      "--mode",
      "mock",
      "--id",
      "j",
      "--scope",
      "project",
    ]);
    expect(r.code).toBe(0);
    expect(await Bun.file(join(cwd, "devzy.yaml")).exists()).toBe(true);

    const explicit = join(dir, "explicit", "devzy.yaml");
    const e = await cli(["providers", "add", "--type", "jira", "--mode", "mock", "--id", "j2"], {
      DEVZY_CONFIG_PATH: explicit,
    });
    expect(e.code).toBe(0);
    expect(await readFile(explicit, "utf8")).toContain("id: j2");
    const conflict = await cli(
      ["providers", "add", "--type", "jira", "--mode", "mock", "--id", "j3", "--scope", "user"],
      {
        DEVZY_CONFIG_PATH: explicit,
      },
    );
    expect(conflict.code).toBe(2);
  });

  test("refuses to modify an invalid existing file", async () => {
    await writeText(userConfig(), "providers: [\n");
    const r = await cli(["providers", "add", "--type", "jira", "--mode", "mock", "--id", "j"]);
    expect(r.code).toBe(4);
    expect(await readFile(userConfig(), "utf8")).toBe("providers: [\n");
  });
});

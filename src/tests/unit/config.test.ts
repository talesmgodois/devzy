import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigError } from "../../lib/errors.ts";
import { loadConfig, mergeConfigFiles, parseConfigText } from "../../services/config/load.ts";
import { resolveConfigPaths } from "../../services/config/paths.ts";
import { ProviderRegistry } from "../../services/providers/registry.ts";
import { makeTempDir, writeText } from "../helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;
let home: string;
let cwd: string;
const registry = new ProviderRegistry();

beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir());
  home = join(dir, "home");
  cwd = join(dir, "project");
});
afterEach(() => cleanup());

const userPath = () => join(home, ".config", "devzy", "config.yaml");
const projectPath = () => join(cwd, "devzy.yaml");
const load = (env: Record<string, string> = {}) =>
  loadConfig({ env: { HOME: home, ...env }, cwd, registry });

const GH = (id: string, extra = "") => `
  - id: ${id}
    type: github
    name: ${id}
    mode: mock${extra}`;

describe("config paths", () => {
  test("user path honours XDG_CONFIG_HOME, project path is ./devzy.yaml", () => {
    const p = resolveConfigPaths({ HOME: "/h", XDG_CONFIG_HOME: "/xdg" }, "/work");
    expect(p).toEqual({
      explicit: undefined,
      user: "/xdg/devzy/config.yaml",
      project: "/work/devzy.yaml",
    });
    expect(resolveConfigPaths({ HOME: "/h" }, "/work").user).toBe("/h/.config/devzy/config.yaml");
  });

  test("DEVZY_CONFIG_PATH is resolved relative to cwd and expands ~", () => {
    expect(
      resolveConfigPaths({ HOME: "/h", DEVZY_CONFIG_PATH: "conf/x.yaml" }, "/work").explicit,
    ).toBe("/work/conf/x.yaml");
    expect(
      resolveConfigPaths({ HOME: "/h", DEVZY_CONFIG_PATH: "~/x.yaml" }, "/work").explicit,
    ).toBe("/h/x.yaml");
  });

  test("devzy_CONFIG_PATH alias works; conflicting values are rejected", () => {
    expect(resolveConfigPaths({ HOME: "/h", devzy_CONFIG_PATH: "/a.yaml" }, "/w").explicit).toBe(
      "/a.yaml",
    );
    expect(() =>
      resolveConfigPaths(
        { HOME: "/h", devzy_CONFIG_PATH: "/a.yaml", DEVZY_CONFIG_PATH: "/b.yaml" },
        "/w",
      ),
    ).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  test("no files: built-in demo configuration with mock providers", async () => {
    const loaded = await load();
    expect(loaded.builtInDemo).toBe(true);
    expect(loaded.files).toEqual([]);
    expect(loaded.config.providers.every((p) => p.mode === "mock")).toBe(true);
    expect(loaded.config.settings).toEqual({
      defaultPeriodDays: 30,
      healthTimeoutMs: 5000,
      requestTimeoutMs: 15000,
    });
  });

  test("user and project files merge: project wins per setting and per provider id", async () => {
    await writeText(
      userPath(),
      `settings:\n  defaultPeriodDays: 14\n  healthTimeoutMs: 2000\nproviders:${GH("a")}${GH("b")}\n`,
    );
    await writeText(
      projectPath(),
      `settings:\n  defaultPeriodDays: 7\nproviders:\n  - id: b\n    type: gitlab\n    name: B project\n    mode: mock\n${GH("c").slice(1)}\n`,
    );
    const loaded = await load();
    expect(loaded.builtInDemo).toBe(false);
    expect(loaded.files.map((f) => f.scope)).toEqual(["user", "project"]);
    expect(loaded.config.settings.defaultPeriodDays).toBe(7);
    expect(loaded.config.settings.healthTimeoutMs).toBe(2000);
    expect(loaded.config.providers.map((p) => `${p.id}:${p.type}`)).toEqual([
      "a:github",
      "b:gitlab",
      "c:github",
    ]);
  });

  test("merge keeps earlier position for replaced ids", () => {
    const merged = mergeConfigFiles([
      { identities: [{ id: "x", name: "X", emails: [], accounts: [] }] },
      {
        identities: [
          { id: "x", name: "X2", emails: [], accounts: [] },
          { id: "y", name: "Y", emails: [], accounts: [] },
        ],
      },
    ]);
    expect(merged.identities?.map((i) => i.name)).toEqual(["X2", "Y"]);
  });

  test("DEVZY_CONFIG_PATH selects one file and disables discovery", async () => {
    await writeText(userPath(), `providers:${GH("user-only")}\n`);
    const explicit = join(dir, "explicit.yaml");
    await writeText(explicit, `providers:${GH("explicit-only")}\n`);
    const loaded = await load({ DEVZY_CONFIG_PATH: explicit });
    expect(loaded.files.map((f) => f.scope)).toEqual(["explicit"]);
    expect(loaded.config.providers.map((p) => p.id)).toEqual(["explicit-only"]);
  });

  test("missing explicit file is an error", async () => {
    await expect(load({ DEVZY_CONFIG_PATH: join(dir, "missing.yaml") })).rejects.toThrow(
      /not found/,
    );
  });

  test("empty file is valid", async () => {
    await writeText(userPath(), "");
    const loaded = await load();
    expect(loaded.builtInDemo).toBe(false);
    expect(loaded.config.providers).toEqual([]);
  });

  test("environment overrides file values; unset or empty variables do not", async () => {
    await writeText(userPath(), "settings:\n  defaultPeriodDays: 14\n  healthTimeoutMs: 2000\n");
    const loaded = await load({ DEVZY_DEFAULT_PERIOD_DAYS: "60", DEVZY_HEALTH_TIMEOUT_MS: "" });
    expect(loaded.config.settings.defaultPeriodDays).toBe(60);
    expect(loaded.config.settings.healthTimeoutMs).toBe(2000);
    expect(loaded.config.settings.requestTimeoutMs).toBe(15000);
  });

  test("invalid environment override is a config error naming the variable", async () => {
    await expect(load({ DEVZY_DEFAULT_PERIOD_DAYS: "ten" })).rejects.toThrow(
      /DEVZY_DEFAULT_PERIOD_DAYS/,
    );
    await expect(load({ DEVZY_HEALTH_TIMEOUT_MS: "5" })).rejects.toThrow(/between 100/);
  });

  test("malformed YAML reports line/column but never the file contents", async () => {
    await writeText(
      userPath(),
      "providers:\n  - id: x\n    credentials: { token: ghp_SECRETSECRETSECRETSECRET\n",
    );
    const error = await load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    const text = `${(error as ConfigError).message}\n${(error as ConfigError).details.join("\n")}`;
    expect(text).toContain(userPath());
    expect(text).toMatch(/line \d+, column \d+/);
    expect(text).not.toContain("SECRET");
  });

  test("schema errors list paths and never echo secret values", async () => {
    await writeText(
      userPath(),
      `providers:\n  - id: Bad_ID\n    type: githab\n    name: x\n    mode: maybe\n    credentials:\n      token: 12345\n      tokenEnv: "lower case"\n    extra: 1\n`,
    );
    const error = (await load().catch((e: unknown) => e)) as ConfigError;
    const details = error.details.join("\n");
    expect(details).toContain("providers[0].id");
    expect(details).toContain("providers[0].type");
    expect(details).toContain("providers[0].mode");
    expect(details).toContain("providers[0].credentials.token");
    expect(details).toContain("providers[0].credentials.tokenEnv");
    expect(details).toContain('Unrecognized key: "extra"');
    expect(details).not.toContain("12345");
  });

  test("duplicate provider ids in one file are rejected", () => {
    expect(() => parseConfigText(`providers:${GH("a")}${GH("a")}\n`, "f.yaml")).toThrow(
      ConfigError,
    );
  });

  test("adapter options are validated (live GitHub requires repositories)", async () => {
    await writeText(
      userPath(),
      `providers:\n  - id: gh\n    type: github\n    name: GH\n    mode: live\n    options: {}\n`,
    );
    const error = (await load().catch((e: unknown) => e)) as ConfigError;
    expect(error.details.join("\n")).toContain("providers[0].options.repositories");
  });

  test("not-implemented modes are accepted by the loader (reported later, not ignored)", async () => {
    await writeText(
      userPath(),
      `providers:\n  - id: lin\n    type: linear\n    name: Lin\n    mode: live\n`,
    );
    const loaded = await load();
    expect(registry.implementationStatus(loaded.config.providers[0] as never)).toBe(
      "not implemented",
    );
  });

  test("identity accounts must reference configured providers; shared emails produce warnings", async () => {
    await writeText(
      userPath(),
      `providers:${GH("gh")}\nidentities:\n  - id: a\n    name: A\n    emails: [x@example.com]\n    accounts: [{ provider: nope, userId: "1" }]\n`,
    );
    await expect(load()).rejects.toThrow(ConfigError);
    await writeText(
      userPath(),
      `providers:${GH("gh")}\nidentities:\n  - id: a\n    name: A\n    emails: [X@example.com]\n  - id: b\n    name: B\n    emails: [x@example.com]\n`,
    );
    const loaded = await load();
    expect(loaded.warnings.join("\n")).toContain("x@example.com is listed for several identities");
  });
});

describe("credential resolution", () => {
  const live = (id: string, tokenEnv?: string) => `
  - id: ${id}
    type: github
    name: ${id}
    mode: live
    options: { repositories: [acme/api] }${tokenEnv ? `\n    credentials: { tokenEnv: ${tokenEnv} }` : ""}`;

  test("single live instance uses GITHUB_TOKEN; env beats the file token", async () => {
    await writeText(
      userPath(),
      `providers:${live("gh")}\n    credentials: { token: from-file-token }\n`,
    );
    const fromEnv = await load({ GITHUB_TOKEN: "from-env-token" });
    expect(fromEnv.credentials.get("gh")).toMatchObject({
      token: "from-env-token",
      source: "$GITHUB_TOKEN",
    });
    const fromFile = await load();
    expect(fromFile.credentials.get("gh")?.token).toBe("from-file-token");
  });

  test("several live instances: GITHUB_TOKEN is not guessed; tokenEnv maps explicitly", async () => {
    await writeText(userPath(), `providers:${live("gh-a")}${live("gh-b", "GH_B_TOKEN")}\n`);
    const loaded = await load({ GITHUB_TOKEN: "default-token", GH_B_TOKEN: "b-token" });
    expect(loaded.credentials.get("gh-a")?.token).toBeUndefined();
    expect(loaded.credentials.get("gh-a")?.missingHint).toContain("Several live github providers");
    expect(loaded.credentials.get("gh-b")).toMatchObject({
      token: "b-token",
      source: "$GH_B_TOKEN",
    });
  });

  test("mock providers never need credentials", async () => {
    await writeText(userPath(), `providers:${GH("gh")}\n`);
    expect((await load({ GITHUB_TOKEN: "x-token" })).credentials.get("gh")?.token).toBeUndefined();
  });
});

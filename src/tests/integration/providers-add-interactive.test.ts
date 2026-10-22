import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfigText } from "../../services/config/load.ts";
import { isolatedEnv, makeTempDir, runInProcess } from "../helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;
let env: Record<string, string>;
const configPath = () => join(dir, "home", ".config", "devzy", "config.yaml");

beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir());
  env = isolatedEnv(join(dir, "home"));
});
afterEach(() => cleanup());

const add = (stdinLines: string[], args: string[] = []) =>
  runInProcess(["providers", "add", ...args], { cwd: dir, env, stdinLines });

describe("providers add (interactive)", () => {
  test("mock provider: lists types, explains mode, asks no credentials, confirms and saves", async () => {
    // type -> jira (by name), ID default, name default, confirm default (yes)
    const r = await add(["jira", "", "", ""]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Which provider type do you want to add?");
    expect(r.stderr).toMatch(/bitbucket\s+git\s+not implemented/);
    expect(r.stderr).toContain("Jira is mock-only in this version");
    expect(r.stderr).not.toContain("token");
    expect(r.stdout).toContain('Saved provider "jira-mock" (jira, mock)');
    const data = parseConfigText(await readFile(configPath(), "utf8"), "x");
    expect(data.providers?.[0]).toMatchObject({
      id: "jira-mock",
      name: "Jira (mock)",
      mode: "mock",
      enabled: true,
    });
  });

  test("live GitHub: chooses mode, collects repositories and token variable", async () => {
    const r = await add([
      "1",
      "2",
      "gh-main",
      "Acme GitHub",
      "acme/api, acme/web",
      "",
      "ACME_TOKEN",
      "y",
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("GitHub has a mock adapter");
    const data = parseConfigText(await readFile(configPath(), "utf8"), "x");
    expect(data.providers?.[0]).toMatchObject({
      id: "gh-main",
      name: "Acme GitHub",
      mode: "live",
      options: { repositories: ["acme/api", "acme/web"], baseUrl: "https://api.github.com" },
      credentials: { tokenEnv: "ACME_TOKEN" },
    });
    expect(r.stderr).toContain("ACME_TOKEN is not set");
  });

  test("re-prompts on invalid input", async () => {
    const r = await add(["99", "linear", "Bad ID", "lin", "", "y"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Please enter a number between 1 and 7.");
    expect(r.stderr).toContain("IDs use lowercase letters");
    expect(r.stdout).toContain('Saved provider "lin"');
  });

  test("declining confirmation leaves configuration unchanged", async () => {
    const r = await add(["jira", "", "", "n"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Cancelled. Configuration unchanged.");
    expect(await Bun.file(configPath()).exists()).toBe(false);
  });

  test("typing cancel or closing input aborts with exit 130", async () => {
    const cancelled = await add(["cancel"]);
    expect(cancelled.code).toBe(130);
    expect(cancelled.stderr).toContain("Cancelled. No changes were made.");
    const eof = await add(["jira"]);
    expect(eof.code).toBe(130);
    expect(await Bun.file(configPath()).exists()).toBe(false);
  });

  test("not implemented type is explained and nothing is saved", async () => {
    const r = await add(["clickup"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      "ClickUp is a known provider type, but this version has no adapter for it. Nothing was saved.",
    );
    expect(await Bun.file(configPath()).exists()).toBe(false);
  });

  test("--non-interactive disables prompts even on a TTY", async () => {
    const r = await add(["jira"], ["--non-interactive"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Missing required option(s) for non-interactive mode");
  });
});

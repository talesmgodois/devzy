import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "../../lib/errors.ts";
import { parseConfigText } from "../../services/config/load.ts";
import { appendProviderToFile } from "../../services/config/write.ts";
import { makeTempDir, writeText } from "../helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir());
});
afterEach(() => cleanup());

const entry = {
  id: "new-gh",
  type: "github" as const,
  name: "New",
  enabled: true,
  mode: "mock" as const,
  options: {},
};

describe("appendProviderToFile", () => {
  test("creates parent directories and a 0600 file", async () => {
    const path = join(dir, "a", "b", "config.yaml");
    await appendProviderToFile({ path, entry });
    const data = parseConfigText(await readFile(path, "utf8"), path);
    expect(data.providers?.map((p) => p.id)).toEqual(["new-gh"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "a", "b"))).mode & 0o777).toBe(0o700);
  });

  test("preserves unrelated entries, settings and comments", async () => {
    const path = join(dir, "config.yaml");
    await writeText(
      path,
      "# my settings\nversion: 1\nsettings:\n  defaultPeriodDays: 14 # two weeks\nproviders:\n  - id: keep\n    type: jira\n    name: Keep\n    mode: mock\nidentities: []\n",
    );
    await appendProviderToFile({ path, entry });
    const text = await readFile(path, "utf8");
    expect(text).toContain("# my settings");
    expect(text).toContain("# two weeks");
    const data = parseConfigText(text, path);
    expect(data.settings?.defaultPeriodDays).toBe(14);
    expect(data.providers?.map((p) => p.id)).toEqual(["keep", "new-gh"]);
  });

  test("never modifies a malformed or invalid file", async () => {
    const path = join(dir, "config.yaml");
    const broken = "providers: [\n";
    await writeText(path, broken);
    await expect(appendProviderToFile({ path, entry })).rejects.toThrow(ConfigError);
    expect(await readFile(path, "utf8")).toBe(broken);

    const invalid = "providers:\n  - id: x\n    type: nope\n    name: x\n    mode: mock\n";
    await writeText(path, invalid);
    await expect(appendProviderToFile({ path, entry })).rejects.toThrow(ConfigError);
    expect(await readFile(path, "utf8")).toBe(invalid);
  });

  test("a failing validate callback aborts before writing and leaves no temp files", async () => {
    const path = join(dir, "config.yaml");
    await writeText(path, "providers: []\n");
    await expect(
      appendProviderToFile({
        path,
        entry,
        validate: () => {
          throw new ConfigError("merged config invalid");
        },
      }),
    ).rejects.toThrow("merged config invalid");
    expect(await readFile(path, "utf8")).toBe("providers: []\n");
    expect(await readdir(dir)).toEqual(["config.yaml"]);
  });

  test("rejects a file whose providers key is not a list", async () => {
    const path = join(dir, "config.yaml");
    await writeText(path, "providers: {}\n");
    await expect(appendProviderToFile({ path, entry })).rejects.toThrow(ConfigError);
  });
});

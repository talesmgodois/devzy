import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseConfigText, resolveConfig } from "../../services/config/load.ts";
import { ProviderRegistry } from "../../services/providers/registry.ts";

const EXAMPLE = resolve(import.meta.dir, "../../../devzy.example.yaml");

describe("devzy.example.yaml", () => {
  test("is valid and contains no credentials", async () => {
    const text = await readFile(EXAMPLE, "utf8");
    const data = parseConfigText(text, EXAMPLE);
    const { config } = resolveConfig(
      [{ path: EXAMPLE, scope: "explicit", data }],
      {},
      new ProviderRegistry(),
    );
    expect(config.providers.length).toBeGreaterThan(0);
    expect(config.providers.every((p) => p.credentials?.token === undefined)).toBe(true);
    expect(text).not.toMatch(/gh[pousr]_[A-Za-z0-9]{10,}|github_pat_|glpat-|lin_api_/);
  });
});

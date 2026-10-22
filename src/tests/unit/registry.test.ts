import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../services/config/schema.ts";
import { PROVIDER_TYPE_IDS } from "../../services/providers/catalog.ts";
import { ProviderRegistry } from "../../services/providers/registry.ts";
import { entry } from "./fakes.ts";

const registry = new ProviderRegistry();
const noFetch = () => Promise.reject(new Error("no network"));
const noCredential = { token: undefined, source: undefined, missingHint: "Set GITHUB_TOKEN." };

describe("ProviderRegistry", () => {
  test("knows every catalog type, including ones without adapters", () => {
    expect(registry.listTypes().map((t) => t.type)).toEqual(PROVIDER_TYPE_IDS);
    expect(registry.getType("bitbucket")?.adapters).toEqual({});
    expect(registry.getType("nope")).toBeUndefined();
  });

  test("distinguishes mock and live adapters", () => {
    expect(registry.adapterFor("github", "mock")?.mode).toBe("mock");
    expect(registry.adapterFor("github", "live")?.mode).toBe("live");
    expect(registry.adapterFor("gitlab", "live")).toBeUndefined();
    expect(registry.implementationStatus({ type: "jira", mode: "mock" })).toBe("available");
    expect(registry.implementationStatus({ type: "clickup", mode: "mock" })).toBe(
      "not implemented",
    );
  });

  test.each(["github", "gitlab", "jira", "linear"] as const)(
    "instantiates the %s mock adapter",
    (type) => {
      const result = registry.instantiate(
        entry(`${type}-x`, type),
        noCredential,
        DEFAULT_SETTINGS,
        noFetch,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.provider.mode).toBe("mock");
        expect(result.provider.category).toBe(registry.categoryOf({ type }));
      }
    },
  );

  test("unsupported type/mode fails explicitly instead of returning a provider", () => {
    const result = registry.instantiate(
      entry("bb", "bitbucket"),
      noCredential,
      DEFAULT_SETTINGS,
      noFetch,
    );
    expect(result).toEqual({
      ok: false,
      message: "Bitbucket mock adapter is not implemented in this version.",
    });
    const live = registry.instantiate(
      entry("gl", "gitlab", { mode: "live" }),
      noCredential,
      DEFAULT_SETTINGS,
      noFetch,
    );
    expect(live.ok).toBe(false);
    if (!live.ok) expect(live.message).toContain("Available modes: mock");
  });

  test("live adapter without a token fails with the credential hint", () => {
    const result = registry.instantiate(
      entry("gh", "github", { mode: "live", options: { repositories: ["acme/api"] } }),
      noCredential,
      DEFAULT_SETTINGS,
      noFetch,
    );
    expect(result).toEqual({ ok: false, message: "Missing credentials. Set GITHUB_TOKEN." });
  });
});

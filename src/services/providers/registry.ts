import type { ProviderCategory, ProviderMode, ReportSource } from "../../domain/activity.ts";
import { errorMessage } from "../../lib/errors.ts";
import type { ProviderEntry, Settings } from "../config/schema.ts";
import { formatIssues } from "../config/schema.ts";
import type { AdapterDefinition, FetchLike, Provider } from "./adapter.ts";
import { PROVIDER_TYPES, type ProviderTypeId } from "./catalog.ts";
import { githubLiveAdapter } from "./git/github.provider.ts";
import { gitlabLiveAdapter } from "./git/gitlab.provider.ts";
import { githubMockAdapter } from "./git/mock/github.mock.ts";
import { gitlabMockAdapter } from "./git/mock/gitlab.mock.ts";
import { jiraLiveAdapter } from "./tasks/jira.provider.ts";
import { jiraMockAdapter } from "./tasks/mock/jira.mock.ts";
import { linearMockAdapter } from "./tasks/mock/linear.mock.ts";
import { openprojectLiveAdapter } from "./tasks/openproject.provider.ts";

export interface ProviderTypeInfo {
  type: ProviderTypeId;
  category: ProviderCategory;
  displayName: string;
  adapters: Partial<Record<ProviderMode, AdapterDefinition>>;
}

/** `available`: an adapter exists for the configured mode; otherwise `not implemented`. */
export type ImplementationStatus = "available" | "not implemented";

export interface ResolvedCredential {
  token: string | undefined;
  /** Human-readable origin, e.g. `$GITHUB_TOKEN`; never the value. */
  source: string | undefined;
  /** Hint shown when no token was found. */
  missingHint: string;
}

export type InstantiateResult = { ok: true; provider: Provider } | { ok: false; message: string };

export type AdapterTable = Partial<
  Record<ProviderTypeId, Partial<Record<ProviderMode, AdapterDefinition>>>
>;

/** Adapters shipped in this build. Types without an entry are known but not implemented. */
export const BUILT_IN_ADAPTERS: AdapterTable = {
  github: { mock: githubMockAdapter, live: githubLiveAdapter },
  gitlab: { mock: gitlabMockAdapter, live: gitlabLiveAdapter },
  jira: { mock: jiraMockAdapter, live: jiraLiveAdapter },
  linear: { mock: linearMockAdapter },
  openproject: { live: openprojectLiveAdapter },
};

/**
 * Maps provider types to adapters and turns configured entries into provider
 * instances. Commands use the registry instead of importing adapters.
 */
export class ProviderRegistry {
  readonly #types: Map<ProviderTypeId, ProviderTypeInfo>;

  constructor(adapters: AdapterTable = BUILT_IN_ADAPTERS) {
    this.#types = new Map(
      (Object.keys(PROVIDER_TYPES) as ProviderTypeId[]).map((type) => [
        type,
        {
          type,
          category: PROVIDER_TYPES[type].category,
          displayName: PROVIDER_TYPES[type].displayName,
          adapters: { ...adapters[type] },
        },
      ]),
    );
  }

  /** All known provider types, in catalog order. */
  listTypes(): ProviderTypeInfo[] {
    return [...this.#types.values()];
  }

  getType(type: string): ProviderTypeInfo | undefined {
    return this.#types.get(type as ProviderTypeId);
  }

  adapterFor(type: string, mode: ProviderMode): AdapterDefinition | undefined {
    return this.getType(type)?.adapters[mode];
  }

  implementationStatus(entry: Pick<ProviderEntry, "type" | "mode">): ImplementationStatus {
    return this.adapterFor(entry.type, entry.mode) ? "available" : "not implemented";
  }

  categoryOf(entry: Pick<ProviderEntry, "type">): ProviderCategory {
    return PROVIDER_TYPES[entry.type].category;
  }

  source(entry: ProviderEntry): ReportSource {
    return {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      category: this.categoryOf(entry),
      mode: entry.mode,
    };
  }

  /** Validates `options` against the adapter schema. Returns `path: message` lines. */
  validateOptions(entry: ProviderEntry, path: string): string[] {
    const adapter = this.adapterFor(entry.type, entry.mode);
    if (!adapter) return [];
    const result = adapter.optionsSchema.safeParse(entry.options);
    return result.success ? [] : formatIssues(result.error, `${path}.options`);
  }

  /**
   * Resolves an instance's token. Order (first non-empty wins):
   * 1. the variable named by `credentials.tokenEnv`;
   * 2. the type's conventional variable (e.g. GITHUB_TOKEN), only when
   *    `tokenEnv` is not set and this is the only configured live instance
   *    of its type;
   * 3. `credentials.token` from the configuration file.
   */
  resolveCredential(
    entry: ProviderEntry,
    allEntries: readonly ProviderEntry[],
    env: Readonly<Record<string, string | undefined>>,
  ): ResolvedCredential {
    const spec = this.adapterFor(entry.type, entry.mode)?.credential;
    if (!spec) return { token: undefined, source: undefined, missingHint: "" };

    const explicitEnv = entry.credentials?.tokenEnv;
    if (explicitEnv) {
      const value = env[explicitEnv];
      if (value) return { token: value, source: `$${explicitEnv}`, missingHint: "" };
    } else {
      const sameType = allEntries.filter((e) => e.type === entry.type && e.mode === "live");
      const value = env[spec.defaultEnv];
      if (value && sameType.length === 1) {
        return { token: value, source: `$${spec.defaultEnv}`, missingHint: "" };
      }
    }
    if (entry.credentials?.token) {
      return {
        token: entry.credentials.token,
        source: "credentials.token in the configuration file",
        missingHint: "",
      };
    }

    const sameTypeCount = allEntries.filter(
      (e) => e.type === entry.type && e.mode === "live",
    ).length;
    const missingHint = explicitEnv
      ? `Set the ${explicitEnv} environment variable.`
      : sameTypeCount === 1
        ? `Set ${spec.defaultEnv} or credentials.tokenEnv for provider "${entry.id}".`
        : `Several live ${entry.type} providers are configured, so ${spec.defaultEnv} is not applied automatically; set credentials.tokenEnv for provider "${entry.id}".`;
    return { token: undefined, source: undefined, missingHint };
  }

  instantiate(
    entry: ProviderEntry,
    credential: ResolvedCredential,
    settings: Settings,
    fetchImpl: FetchLike,
  ): InstantiateResult {
    const info = this.getType(entry.type);
    const adapter = info?.adapters[entry.mode];
    if (!info || !adapter) {
      const available = Object.keys(info?.adapters ?? {});
      const suffix = available.length > 0 ? ` Available modes: ${available.join(", ")}.` : "";
      return {
        ok: false,
        message: `${info?.displayName ?? entry.type} ${entry.mode} adapter is not implemented in this version.${suffix}`,
      };
    }
    if (adapter.credential && !credential.token) {
      return { ok: false, message: `Missing credentials. ${credential.missingHint}` };
    }
    try {
      const provider = adapter.create({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        options: entry.options,
        token: credential.token,
        tokenSource: credential.source,
        settings,
        fetch: fetchImpl,
      });
      return { ok: true, provider };
    } catch (error) {
      return { ok: false, message: `Could not initialise provider: ${errorMessage(error)}` };
    }
  }
}

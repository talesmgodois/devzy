import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { normalizeEmail } from "../../domain/identity.ts";
import { ConfigError, errorMessage } from "../../lib/errors.ts";
import type { ProviderRegistry, ResolvedCredential } from "../providers/registry.ts";
import { BUILT_IN_DEMO_CONFIG } from "./defaults.ts";
import {
  CONFIG_PATH_ENV,
  type ConfigPaths,
  type ConfigScope,
  type Env,
  resolveConfigPaths,
} from "./paths.ts";
import {
  type ConfigFile,
  configFileSchema,
  DEFAULT_SETTINGS,
  type DevzyConfig,
  formatIssues,
  resolvedConfigSchema,
  SETTINGS_LIMITS,
  type Settings,
} from "./schema.ts";

export interface LoadedFile {
  path: string;
  scope: ConfigScope;
  data: ConfigFile;
}

export interface LoadedConfig {
  config: DevzyConfig;
  paths: ConfigPaths;
  /** Files that were read, in merge order. Empty when the built-in demo config is used. */
  files: LoadedFile[];
  builtInDemo: boolean;
  credentials: Map<string, ResolvedCredential>;
  warnings: string[];
}

/** Environment variables that override settings. Empty values count as unset. */
export const SETTINGS_ENV: Record<string, keyof Settings> = {
  DEVZY_DEFAULT_PERIOD_DAYS: "defaultPeriodDays",
  DEVZY_HEALTH_TIMEOUT_MS: "healthTimeoutMs",
  DEVZY_REQUEST_TIMEOUT_MS: "requestTimeoutMs",
};

export interface LoadOptions {
  env: Env;
  cwd: string;
  registry: ProviderRegistry;
}

/**
 * Loads configuration.
 *
 * - If DEVZY_CONFIG_PATH is set, only that file is read and it must exist.
 * - Otherwise the user file and then the project file (`./devzy.yaml`) are read
 *   if present and merged (project wins; see {@link mergeConfigFiles}).
 * - If no file exists, the built-in mock demo configuration is used.
 *
 * Settings precedence: built-in defaults < file values < environment variables
 * (< CLI options, applied by the command that supports them).
 */
export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
  const paths = resolveConfigPaths(options.env, options.cwd);
  const files = await readConfigFiles(paths, { allowMissingExplicit: false });
  const builtInDemo = files.length === 0;
  const sources = builtInDemo
    ? [{ path: "built-in demo configuration", scope: "user" as const, data: BUILT_IN_DEMO_CONFIG }]
    : files;
  const resolved = resolveConfig(sources, options.env, options.registry);
  return { ...resolved, paths, files, builtInDemo };
}

/**
 * Reads the files selected by {@link resolveConfigPaths}, in merge order.
 * A missing explicit file is an error unless `allowMissingExplicit` is set
 * (used by `providers add`, which may create it).
 */
export async function readConfigFiles(
  paths: ConfigPaths,
  options: { allowMissingExplicit: boolean },
): Promise<LoadedFile[]> {
  if (paths.explicit) {
    const data = await readConfigFile(paths.explicit);
    if (data === undefined) {
      if (options.allowMissingExplicit) return [];
      throw new ConfigError(
        `Configuration file not found: ${paths.explicit} (set by ${CONFIG_PATH_ENV}).`,
        [],
        `Create it with "devzy providers add" or unset ${CONFIG_PATH_ENV}.`,
      );
    }
    return [{ path: paths.explicit, scope: "explicit", data }];
  }
  const files: LoadedFile[] = [];
  for (const scope of ["user", "project"] as const) {
    const path = paths[scope];
    const data = await readConfigFile(path);
    if (data !== undefined) files.push({ path, scope, data });
  }
  return files;
}

/** Reads and validates one file. Returns undefined when it does not exist. */
export async function readConfigFile(path: string): Promise<ConfigFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EISDIR") throw new ConfigError(`Configuration path is a directory: ${path}`);
    if (code === "EACCES")
      throw new ConfigError(`Permission denied reading configuration: ${path}`);
    throw new ConfigError(`Could not read configuration ${path}: ${errorMessage(error)}`);
  }
  return parseConfigText(text, path);
}

/** Parses YAML text into a validated file model. Errors never quote file contents. */
export function parseConfigText(text: string, path: string): ConfigFile {
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    const details = doc.errors.map((err) => {
      const { line, col } = lineCol(text, err.pos[0]);
      return `YAML syntax error (${err.code}) at line ${line}, column ${col}`;
    });
    throw new ConfigError(`Malformed YAML in ${path}.`, details);
  }
  const raw: unknown = doc.toJS() ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`Invalid configuration in ${path}.`, [
      "the top level must be a mapping (key: value)",
    ]);
  }
  const result = configFileSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration in ${path}.`, formatIssues(result.error));
  }
  const duplicates = duplicateIds(result.data.providers ?? [], "providers");
  duplicates.push(...duplicateIds(result.data.identities ?? [], "identities"));
  if (duplicates.length > 0) throw new ConfigError(`Invalid configuration in ${path}.`, duplicates);
  return result.data;
}

function duplicateIds(items: readonly { id: string }[], key: string): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  items.forEach((item, index) => {
    if (seen.has(item.id)) errors.push(`${key}[${index}].id: duplicate id "${item.id}"`);
    seen.add(item.id);
  });
  return errors;
}

function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return { line: lines.length, col: (lines.at(-1)?.length ?? 0) + 1 };
}

/**
 * Merges files in order. Later files win:
 * - `settings`: per key.
 * - `providers` / `identities`: per `id`; a later entry replaces the earlier
 *   entry with the same id entirely (keeping its position); new ids are appended.
 */
export function mergeConfigFiles(files: readonly ConfigFile[]): ConfigFile {
  const settings: Partial<Settings> = {};
  const providers = new Map<string, NonNullable<ConfigFile["providers"]>[number]>();
  const identities = new Map<string, NonNullable<ConfigFile["identities"]>[number]>();
  for (const file of files) {
    Object.assign(settings, file.settings ?? {});
    for (const p of file.providers ?? []) providers.set(p.id, p);
    for (const i of file.identities ?? []) identities.set(i.id, i);
  }
  return {
    version: 1,
    settings,
    providers: [...providers.values()],
    identities: [...identities.values()],
  };
}

export function settingsFromEnv(env: Env): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const [name, key] of Object.entries(SETTINGS_ENV)) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const [min, max] = SETTINGS_LIMITS[key];
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new ConfigError(
        `Environment variable ${name} must be a whole number between ${min} and ${max}.`,
      );
    }
    out[key] = value;
  }
  return out;
}

/** Applies defaults and env overrides, validates cross-references and resolves credentials. */
export function resolveConfig(
  files: readonly LoadedFile[],
  env: Env,
  registry: ProviderRegistry,
): Pick<LoadedConfig, "config" | "credentials" | "warnings"> {
  const where = files.map((f) => f.path).join(" + ");
  const merged = mergeConfigFiles(files.map((f) => f.data));
  const candidate = {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, ...merged.settings, ...settingsFromEnv(env) },
    providers: merged.providers ?? [],
    identities: merged.identities ?? [],
  };
  const parsed = resolvedConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration (${where}).`, formatIssues(parsed.error));
  }
  const config = parsed.data as DevzyConfig;

  const errors: string[] = [];
  const warnings: string[] = [];
  const providerIds = new Set(config.providers.map((p) => p.id));
  config.providers.forEach((entry, index) => {
    errors.push(...registry.validateOptions(entry, `providers[${index}]`));
  });

  const emailOwners = new Map<string, string[]>();
  const accountOwners = new Map<string, string[]>();
  config.identities.forEach((member, index) => {
    member.accounts.forEach((account, accountIndex) => {
      if (!providerIds.has(account.provider)) {
        errors.push(
          `identities[${index}].accounts[${accountIndex}].provider: unknown provider "${account.provider}"`,
        );
      }
      const key = `${account.provider}:${account.userId ?? `@${account.username?.toLowerCase()}`}`;
      accountOwners.set(key, [...(accountOwners.get(key) ?? []), member.id]);
    });
    for (const email of member.emails) {
      const normalized = normalizeEmail(email) ?? email;
      emailOwners.set(normalized, [...(emailOwners.get(normalized) ?? []), member.id]);
    }
  });
  for (const [email, owners] of emailOwners) {
    if (owners.length > 1) {
      warnings.push(
        `Email ${email} is listed for several identities (${owners.join(", ")}); matches on it are ambiguous.`,
      );
    }
  }
  for (const [account, owners] of accountOwners) {
    if (owners.length > 1) {
      warnings.push(
        `Account ${account} is listed for several identities (${owners.join(", ")}); matches on it are ambiguous.`,
      );
    }
  }
  if (errors.length > 0) throw new ConfigError(`Invalid configuration (${where}).`, errors);

  const credentials = new Map<string, ResolvedCredential>();
  for (const entry of config.providers) {
    credentials.set(entry.id, registry.resolveCredential(entry, config.providers, env));
  }
  return { config, credentials, warnings };
}

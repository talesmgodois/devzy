import type { ProviderCategory, ProviderMode } from "../domain/activity.ts";
import { DevzyError, ExitCode, type ExitCodeValue, UsageError } from "../lib/errors.ts";
import { Prompter } from "../lib/prompts.ts";
import { renderTable } from "../lib/table.ts";
import { type LoadedFile, readConfigFiles, resolveConfig } from "../services/config/load.ts";
import { type ConfigScope, resolveConfigPaths } from "../services/config/paths.ts";
import {
  ENV_VAR_RE,
  formatIssues,
  PROVIDER_ID_RE,
  type ProviderEntryInput,
  providerEntrySchema,
} from "../services/config/schema.ts";
import { appendProviderToFile } from "../services/config/write.ts";
import type { AdapterDefinition, SetupField } from "../services/providers/adapter.ts";
import type { ProviderTypeInfo } from "../services/providers/registry.ts";
import { parseCommandArgs } from "./args.ts";
import { type CommandContext, describeConfigSource } from "./context.ts";

const CATEGORIES: readonly ProviderCategory[] = ["git", "tasks"];

export async function runProvidersList(
  ctx: CommandContext,
  tokens: string[],
): Promise<ExitCodeValue> {
  parseCommandArgs(tokens, {}, "devzy providers help");
  const loaded = await ctx.config();
  const { registry } = ctx.deps;
  const { log } = ctx;
  const width = log.terminalWidth;

  log.out(describeConfigSource(loaded));
  log.out();
  log.out("Known provider types");
  log.out(
    renderTable(
      [
        { header: "Type" },
        { header: "Name" },
        { header: "Category" },
        { header: "Mock adapter" },
        { header: "Live adapter" },
      ],
      registry
        .listTypes()
        .map((t) => [
          t.type,
          t.displayName,
          t.category,
          t.adapters.mock ? "available" : "not implemented",
          t.adapters.live ? "available" : "not implemented",
        ]),
      { maxWidth: width },
    ),
  );

  for (const category of CATEGORIES) {
    const entries = loaded.config.providers.filter((e) => registry.categoryOf(e) === category);
    log.out();
    log.out(`Configured ${category} providers`);
    if (entries.length === 0) {
      log.out("  (none)");
      continue;
    }
    log.out(
      renderTable(
        [
          { header: "ID" },
          { header: "Name", flex: true },
          { header: "Type" },
          { header: "Enabled" },
          { header: "Mode" },
          { header: "Implementation" },
          { header: "Credentials", flex: true },
        ],
        entries.map((e) => {
          const credential = loaded.credentials.get(e.id);
          const spec = registry.adapterFor(e.type, e.mode)?.credential;
          const credText = !spec
            ? "not needed"
            : credential?.token
              ? `${credential.source ?? "configured"} (set)`
              : "missing";
          return [
            e.id,
            e.name,
            e.type,
            e.enabled ? "yes" : "no",
            e.mode,
            registry.implementationStatus(e),
            credText,
          ];
        }),
        { maxWidth: width },
      ),
    );
  }
  log.out();
  log.out(
    'Health checks are a provider capability, not a separate category. Run "devzy health" to check providers.',
  );
  return ExitCode.Success;
}

const ADD_OPTION_SPEC = {
  type: { type: "string" },
  mode: { type: "string" },
  id: { type: "string" },
  name: { type: "string" },
  repo: { type: "string", multiple: true },
  "base-url": { type: "string" },
  "token-env": { type: "string" },
  disabled: { type: "boolean" },
  scope: { type: "string" },
  yes: { type: "boolean", short: "y" },
} as const;

const HELP_HINT = 'Run "devzy providers add --help" for usage.';

function modeDescription(info: ProviderTypeInfo): string {
  const { mock, live } = info.adapters;
  if (mock && live)
    return `${info.displayName} has a mock adapter (fixture data, no credentials) and a live adapter (real API).`;
  if (mock)
    return `${info.displayName} is mock-only in this version: it returns deterministic demo data and needs no credentials.`;
  if (live) return `${info.displayName} has a live adapter only.`;
  return `${info.displayName} is a known provider type, but this version has no adapter for it.`;
}

export async function runProvidersAdd(
  ctx: CommandContext,
  tokens: string[],
): Promise<ExitCodeValue> {
  const v = parseCommandArgs(tokens, ADD_OPTION_SPEC, "devzy providers add --help");
  const { env, cwd } = ctx.io;
  const { registry } = ctx.deps;
  const { log } = ctx;

  const paths = resolveConfigPaths(env, cwd);
  if (v.scope !== undefined && paths.explicit) {
    throw new UsageError(
      "--scope cannot be used while DEVZY_CONFIG_PATH is set; that file is always the target.",
    );
  }
  if (v.scope !== undefined && v.scope !== "user" && v.scope !== "project") {
    throw new UsageError(`--scope must be "user" or "project" (got "${v.scope}").`, HELP_HINT);
  }
  const targetScope: ConfigScope = paths.explicit
    ? "explicit"
    : v.scope === "project"
      ? "project"
      : "user";
  const target = paths.explicit ?? (targetScope === "project" ? paths.project : paths.user);

  const files = await readConfigFiles(paths, { allowMissingExplicit: true });
  const current = files.length > 0 ? resolveConfig(files, env, registry).config : undefined;
  const existingIds = new Set(current?.providers.map((p) => p.id) ?? []);

  if (!ctx.interactive) {
    const missing = (["type", "mode", "id"] as const)
      .filter((k) => v[k] === undefined)
      .map((k) => `--${k}`);
    if (missing.length > 0) {
      throw new UsageError(
        `Missing required option(s) for non-interactive mode: ${missing.join(", ")}. Prompts are disabled because stdin is not a terminal or --non-interactive was given.`,
        HELP_HINT,
      );
    }
  }

  const prompter = ctx.interactive ? new Prompter(ctx.io.stdin, ctx.io.stderr) : undefined;
  try {
    // 1. Provider type.
    let typeValue = v.type?.trim().toLowerCase();
    if (typeValue === undefined && prompter) {
      typeValue = await prompter.choose(
        "Which provider type do you want to add?",
        registry.listTypes().map((t) => ({
          value: t.type,
          label: `${t.type.padEnd(12)} ${t.category.padEnd(6)} ${availability(t)}`,
        })),
      );
    }
    const info = typeValue ? registry.getType(typeValue) : undefined;
    if (!info) {
      const known = registry
        .listTypes()
        .map((t) => t.type)
        .join(", ");
      throw new UsageError(
        `Unknown provider type "${typeValue ?? ""}". Known types: ${known}.`,
        HELP_HINT,
      );
    }

    // 2. Explain availability and pick a mode.
    const modes = (Object.keys(info.adapters) as ProviderMode[]).filter((m) => info.adapters[m]);
    if (modes.length === 0) {
      throw new DevzyError(`${modeDescription(info)} Nothing was saved.`, ExitCode.Failure);
    }
    log.diag(modeDescription(info));
    let mode = v.mode?.trim().toLowerCase();
    if (mode === undefined && prompter) {
      if (modes.length === 1) {
        mode = modes[0];
        log.diag(`Using the ${mode} adapter.`);
      } else {
        mode = await prompter.choose(
          "Which mode?",
          modes.map((m) => ({
            value: m,
            label: m === "mock" ? "mock - demo data, no credentials" : "live - real API",
          })),
        );
      }
    }
    if (mode !== "mock" && mode !== "live") {
      throw new UsageError(`--mode must be "mock" or "live" (got "${mode ?? ""}").`, HELP_HINT);
    }
    const adapter = info.adapters[mode];
    if (!adapter) {
      throw new DevzyError(
        `${info.displayName} has no ${mode} adapter in this version (available: ${modes.join(", ")}). Nothing was saved.`,
        ExitCode.Failure,
      );
    }
    rejectInapplicableFlags(v, adapter);

    // 3. Identity of the entry.
    const validateId = (id: string): string | undefined => {
      if (!PROVIDER_ID_RE.test(id))
        return "IDs use lowercase letters, digits and '-', starting with a letter or digit (max 63).";
      if (existingIds.has(id)) return `A provider with ID "${id}" already exists.`;
      return undefined;
    };
    const id =
      v.id ??
      (await prompter?.ask("Provider ID", {
        default: suggestId(info.type, mode, existingIds),
        validate: validateId,
      }));
    const idProblem = id === undefined ? "missing" : validateId(id);
    if (id === undefined || idProblem)
      throw new UsageError(`Invalid --id: ${idProblem}`, HELP_HINT);

    const defaultName = `${info.displayName}${mode === "mock" ? " (mock)" : ""}`;
    const name =
      v.name ??
      (prompter
        ? await prompter.ask("Display name", {
            default: defaultName,
            validate: (n) => (n.trim() ? undefined : "Required."),
          })
        : defaultName);

    // 4. Adapter-specific options and credentials (nothing for mock adapters).
    const options: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const field of adapter.setupFields) {
      const value = await collectField(field, v, prompter);
      if (value === undefined) {
        if (field.required) missing.push(`--${field.flag}`);
        continue;
      }
      options[field.key] = value;
    }
    let tokenEnv: string | undefined;
    if (adapter.credential) {
      const spec = adapter.credential;
      tokenEnv =
        v["token-env"] ??
        (prompter
          ? await prompter.ask(`Environment variable that holds the token (${spec.description})`, {
              default: spec.defaultEnv,
              validate: (n) =>
                ENV_VAR_RE.test(n) ? undefined : "Use a variable name such as GITHUB_TOKEN.",
            })
          : spec.defaultEnv);
    }
    if (missing.length > 0) {
      throw new UsageError(
        `Missing required option(s) for a ${mode} ${info.type} provider: ${missing.join(", ")}.`,
        HELP_HINT,
      );
    }

    const entry: ProviderEntryInput = {
      id,
      type: info.type,
      name: name.trim(),
      enabled: !v.disabled,
      mode,
      options,
      ...(tokenEnv ? { credentials: { tokenEnv } } : {}),
    };
    validateEntry(entry, adapter);

    // 5. Confirm and save.
    log.diag("");
    log.diag(`Provider to add (${target}):`);
    log.diag(
      `  id: ${entry.id}\n  type: ${entry.type}\n  mode: ${entry.mode}\n  name: ${entry.name}\n  enabled: ${entry.enabled}`,
    );
    for (const [key, value] of Object.entries(options)) {
      log.diag(`  options.${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    }
    if (tokenEnv) log.diag(`  credentials.tokenEnv: ${tokenEnv} (the token itself is not stored)`);

    if (prompter && !v.yes && !(await prompter.confirm("Save this provider?", true))) {
      log.out("Cancelled. Configuration unchanged.");
      return ExitCode.Success;
    }

    await appendProviderToFile({
      path: target,
      entry,
      validate: (data) => {
        resolveConfig(
          withReplacedFile(files, { path: target, scope: targetScope, data }),
          env,
          registry,
        );
      },
    });

    log.out(`Saved provider "${entry.id}" (${entry.type}, ${entry.mode}) to ${target}.`);
    if (tokenEnv && !env[tokenEnv]) {
      log.warn(
        `${tokenEnv} is not set; "${entry.id}" will report missing credentials until it is.`,
      );
    }
    if (files.length === 0 && !paths.explicit) {
      log.info(
        "A configuration file now exists, so the built-in demo providers are no longer used.",
      );
    }
    return ExitCode.Success;
  } finally {
    prompter?.close();
  }
}

function availability(info: ProviderTypeInfo): string {
  const { mock, live } = info.adapters;
  if (mock && live) return "mock + live";
  if (mock) return "mock only";
  if (live) return "live only";
  return "not implemented";
}

function suggestId(type: string, mode: ProviderMode, existing: ReadonlySet<string>): string {
  const base = mode === "mock" ? `${type}-mock` : type;
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) if (!existing.has(`${base}-${n}`)) return `${base}-${n}`;
}

type AddValues = ReturnType<typeof parseCommandArgs<typeof ADD_OPTION_SPEC>>;

function rejectInapplicableFlags(v: AddValues, adapter: AdapterDefinition): void {
  const flags = new Set(adapter.setupFields.map((f) => f.flag));
  if (v.repo !== undefined && !flags.has("repo")) {
    throw new UsageError(
      `--repo does not apply to a ${adapter.mode} adapter of this type.`,
      HELP_HINT,
    );
  }
  if (v["base-url"] !== undefined && !flags.has("base-url")) {
    throw new UsageError(
      `--base-url does not apply to a ${adapter.mode} adapter of this type.`,
      HELP_HINT,
    );
  }
  if (v["token-env"] !== undefined && !adapter.credential) {
    throw new UsageError("--token-env applies only to adapters that need a token.", HELP_HINT);
  }
}

async function collectField(
  field: SetupField,
  v: AddValues,
  prompter: Prompter | undefined,
): Promise<unknown> {
  if (field.kind === "list") {
    const given = field.flag === "repo" ? v.repo : undefined;
    if (given && given.length > 0) return given.map((s) => s.trim());
    if (!prompter) return undefined;
    const answer = await prompter.ask(field.label, {
      default: field.default,
      validate: (a) =>
        field.required && !a.trim() ? "At least one value is required." : undefined,
    });
    const list = answer
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  const given = field.flag === "base-url" ? v["base-url"] : undefined;
  if (given !== undefined) return given.trim();
  if (!prompter) return field.default;
  const answer = await prompter.ask(field.label, { default: field.default });
  return answer.trim() || undefined;
}

function validateEntry(entry: ProviderEntryInput, adapter: AdapterDefinition): void {
  const base = providerEntrySchema.safeParse(entry);
  const opts = adapter.optionsSchema.safeParse(entry.options);
  const problems = [
    ...(base.success ? [] : formatIssues(base.error)),
    ...(opts.success ? [] : formatIssues(opts.error, "options")),
  ];
  if (problems.length > 0) {
    throw new UsageError(`Invalid provider settings: ${problems.join("; ")}`, HELP_HINT);
  }
}

/** Replaces (or inserts, in user → project order) the target file in the merge list. */
function withReplacedFile(files: readonly LoadedFile[], next: LoadedFile): LoadedFile[] {
  const order: Record<ConfigScope, number> = { user: 0, project: 1, explicit: 0 };
  return [...files.filter((f) => f.path !== next.path), next].sort(
    (a, b) => order[a.scope] - order[b.scope],
  );
}

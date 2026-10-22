import type { Logger, OutputStream } from "../lib/logger.ts";
import type { ProviderRuntime } from "../services/aggregation.ts";
import { type LoadedConfig, loadConfig } from "../services/config/load.ts";
import type { Env } from "../services/config/paths.ts";
import type { FetchLike } from "../services/providers/adapter.ts";
import { ProviderRegistry } from "../services/providers/registry.ts";

export interface InputStream extends NodeJS.ReadableStream {
  isTTY?: boolean | undefined;
}

export interface CliIO {
  stdout: OutputStream;
  stderr: OutputStream;
  stdin: InputStream;
  env: Env;
  cwd: string;
}

/** Injectable collaborators (tests replace them). */
export interface CliDeps {
  registry: ProviderRegistry;
  fetch: FetchLike;
  now: () => Date;
}

export function defaultDeps(): CliDeps {
  return {
    registry: new ProviderRegistry(),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  };
}

export class CommandContext {
  #config: Promise<LoadedConfig> | undefined;

  constructor(
    readonly io: CliIO,
    readonly deps: CliDeps,
    readonly log: Logger,
    /** False when stdin is not a TTY or --non-interactive was given. */
    readonly interactive: boolean,
  ) {}

  /** Loads configuration once, registering secrets for redaction and printing warnings. */
  config(): Promise<LoadedConfig> {
    this.#config ??= loadConfig({
      env: this.io.env,
      cwd: this.io.cwd,
      registry: this.deps.registry,
    }).then((loaded) => {
      for (const credential of loaded.credentials.values())
        this.log.redactor.register(credential.token);
      for (const entry of loaded.config.providers)
        this.log.redactor.register(entry.credentials?.token);
      for (const warning of loaded.warnings) this.log.warn(warning);
      return loaded;
    });
    return this.#config;
  }

  async runtime(): Promise<ProviderRuntime> {
    const loaded = await this.config();
    return {
      registry: this.deps.registry,
      config: loaded.config,
      credentials: loaded.credentials,
      fetch: this.deps.fetch,
    };
  }
}

/** One-line description of where configuration came from, for report context. */
export function describeConfigSource(loaded: LoadedConfig): string {
  if (loaded.builtInDemo) {
    return "No configuration file found; using the built-in mock demo configuration.";
  }
  return `Configuration: ${loaded.files.map((f) => `${f.path} (${f.scope})`).join(", ")}`;
}

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigError } from "../../lib/errors.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** Canonical variable. `devzy_CONFIG_PATH` is accepted as an alias. */
export const CONFIG_PATH_ENV = "DEVZY_CONFIG_PATH";
export const CONFIG_PATH_ENV_ALIAS = "devzy_CONFIG_PATH";
export const PROJECT_CONFIG_FILENAME = "devzy.yaml";

export type ConfigScope = "explicit" | "user" | "project";

export interface ConfigPaths {
  /** Set when DEVZY_CONFIG_PATH is used; implicit discovery is then disabled. */
  explicit: string | undefined;
  /** `$XDG_CONFIG_HOME/devzy/config.yaml`, falling back to `~/.config/devzy/config.yaml`. */
  user: string;
  /** `./devzy.yaml` in the working directory. */
  project: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function resolveConfigPaths(env: Env, cwd: string): ConfigPaths {
  const home = nonEmpty(env["HOME"]) ?? homedir();
  const canonical = nonEmpty(env[CONFIG_PATH_ENV]);
  const alias = nonEmpty(env[CONFIG_PATH_ENV_ALIAS]);
  if (canonical && alias && canonical !== alias) {
    throw new ConfigError(
      `${CONFIG_PATH_ENV} and ${CONFIG_PATH_ENV_ALIAS} are both set to different paths; set only one.`,
    );
  }
  const explicitRaw = canonical ?? alias;
  const explicit = explicitRaw ? resolve(cwd, expandHome(explicitRaw, home)) : undefined;

  const xdg = nonEmpty(env["XDG_CONFIG_HOME"]);
  const configHome = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return {
    explicit,
    user: join(configHome, "devzy", "config.yaml"),
    project: resolve(cwd, PROJECT_CONFIG_FILENAME),
  };
}

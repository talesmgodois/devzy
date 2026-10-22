import type { z } from "zod";
import type { ProviderMode } from "../../domain/activity.ts";
import type { Settings } from "../config/schema.ts";
import type { GitProvider } from "./git/git.interface.ts";
import type { TaskProvider } from "./tasks/task.interface.ts";

export type Provider = GitProvider | TaskProvider;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `providers add` flags that adapters may declare as setup fields. */
export const SETUP_FLAGS = ["repo", "project", "base-url", "account-email"] as const;
export type SetupFlag = (typeof SETUP_FLAGS)[number];

/** A non-secret option collected by `devzy providers add`. */
export interface SetupField {
  /** Key inside the provider entry's `options`. */
  key: string;
  /** CLI flag used to supply the value non-interactively. */
  flag: SetupFlag;
  label: string;
  /** `list`: repeatable flag / comma-separated answer; `url` and `string`: one value. */
  kind: "list" | "url" | "string";
  required: boolean;
  default?: string;
}

/** Describes the token a live adapter needs. */
export interface CredentialSpec {
  /** Conventional environment variable, used when exactly one instance of the type is configured. */
  defaultEnv: string;
  description: string;
}

export interface AdapterContext {
  id: string;
  name: string;
  type: string;
  /** Raw `options` from configuration; the adapter validates them with its own schema. */
  options: unknown;
  /** Resolved credential, if the adapter declares one. */
  token: string | undefined;
  /** Where the token came from, for error messages (e.g. `$GITHUB_TOKEN`). Never the value. */
  tokenSource: string | undefined;
  settings: Settings;
  fetch: FetchLike;
}

export interface AdapterDefinition {
  mode: ProviderMode;
  /** Validates the provider entry's `options`. */
  optionsSchema: z.ZodType;
  /** Options asked for by `providers add`; empty for mock adapters. */
  setupFields: readonly SetupField[];
  credential?: CredentialSpec;
  create(context: AdapterContext): Provider;
}

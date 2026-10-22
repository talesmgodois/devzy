import { z } from "zod";
import type { TeamMember } from "../../domain/identity.ts";
import { isPlausibleEmail } from "../../domain/identity.ts";
import { PROVIDER_TYPE_IDS, type ProviderTypeId } from "../providers/catalog.ts";

export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const providerIdSchema = z.string({ error: "must be a string" }).regex(PROVIDER_ID_RE, {
  error:
    "must be 1-63 characters: lowercase letters, digits and '-', starting with a letter or digit",
});

export const envVarNameSchema = z
  .string({ error: "must be a string" })
  .regex(ENV_VAR_RE, { error: "must be an environment variable name such as GITHUB_TOKEN" });

const credentialsSchema = z.strictObject({
  /** Name of the environment variable holding the token (preferred). */
  tokenEnv: envVarNameSchema.optional(),
  /** Inline token. Discouraged; prefer tokenEnv. Never printed. */
  token: z.string({ error: "must be a string" }).min(1, { error: "must not be empty" }).optional(),
});

export const providerEntrySchema = z.strictObject({
  id: providerIdSchema,
  type: z.enum(PROVIDER_TYPE_IDS, {
    error: `must be one of: ${PROVIDER_TYPE_IDS.join(", ")}`,
  }),
  name: z
    .string({ error: "must be a string" })
    .trim()
    .min(1, { error: "must not be empty" })
    .max(100),
  enabled: z.boolean({ error: "must be true or false" }).default(true),
  mode: z.enum(["mock", "live"], { error: 'must be "mock" or "live"' }),
  options: z.record(z.string(), z.unknown()).default({}),
  credentials: credentialsSchema.optional(),
});

const identityAccountSchema = z
  .strictObject({
    provider: providerIdSchema,
    userId: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
  })
  .refine((a) => a.userId !== undefined || a.username !== undefined, {
    error: "an account needs userId or username",
  });

const emailSchema = z
  .string({ error: "must be a string" })
  .refine(isPlausibleEmail, { error: "must be an email address" })
  .transform((e) => e.trim().toLowerCase());

const teamMemberSchema = z.strictObject({
  id: providerIdSchema,
  name: z.string().trim().min(1, { error: "must not be empty" }),
  emails: z.array(emailSchema).default([]),
  accounts: z.array(identityAccountSchema).default([]),
});

const positiveInt = (min: number, max: number) =>
  z
    .number({ error: "must be a number" })
    .int({ error: "must be a whole number" })
    .min(min, { error: `must be at least ${min}` })
    .max(max, { error: `must be at most ${max}` });

export const SETTINGS_LIMITS = {
  defaultPeriodDays: [1, 3660],
  healthTimeoutMs: [100, 120_000],
  requestTimeoutMs: [100, 300_000],
} as const;

const settingsShape = {
  /** Length of the default reporting period, in days, ending today (UTC). */
  defaultPeriodDays: positiveInt(...SETTINGS_LIMITS.defaultPeriodDays),
  /** Per-provider health-check timeout. */
  healthTimeoutMs: positiveInt(...SETTINGS_LIMITS.healthTimeoutMs),
  /** Per-request timeout used by live adapters. */
  requestTimeoutMs: positiveInt(...SETTINGS_LIMITS.requestTimeoutMs),
};

export const DEFAULT_SETTINGS: Settings = {
  defaultPeriodDays: 30,
  healthTimeoutMs: 5_000,
  requestTimeoutMs: 15_000,
};

/** Schema for one configuration file. Everything is optional so files can be merged. */
export const configFileSchema = z.strictObject({
  version: z.literal(1, { error: "must be 1" }).optional(),
  settings: z.strictObject(settingsShape).partial().optional(),
  providers: z.array(providerEntrySchema, { error: "must be a list" }).optional(),
  identities: z.array(teamMemberSchema, { error: "must be a list" }).optional(),
});

export const resolvedConfigSchema = z.strictObject({
  version: z.literal(1),
  settings: z.strictObject(settingsShape),
  providers: z.array(providerEntrySchema),
  identities: z.array(teamMemberSchema),
});

export type ProviderEntry = z.output<typeof providerEntrySchema> & { type: ProviderTypeId };
export type ProviderEntryInput = z.input<typeof providerEntrySchema>;
export type ConfigFile = z.output<typeof configFileSchema>;
export type Settings = { [K in keyof typeof settingsShape]: number };

export interface DevzyConfig {
  version: 1;
  settings: Settings;
  providers: ProviderEntry[];
  identities: TeamMember[];
}

/** Formats zod issues as `path: message` lines. Never includes input values. */
export function formatIssues(error: z.ZodError, prefix = ""): string[] {
  return error.issues.map((issue) => {
    const path = formatPath([...(prefix ? [prefix] : []), ...issue.path]);
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

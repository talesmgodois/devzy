import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { UsageError } from "../lib/errors.ts";

export const GLOBAL_OPTION_SPEC = {
  help: { type: "boolean", short: "h" },
  quiet: { type: "boolean", short: "q" },
  "non-interactive": { type: "boolean" },
} as const satisfies ParseArgsOptionsConfig;

/**
 * Strictly parses options for one command. Unknown options, missing values
 * and stray positional arguments become a UsageError pointing at the help.
 */
export function parseCommandArgs<T extends ParseArgsOptionsConfig>(
  tokens: string[],
  options: T,
  helpCommand: string,
) {
  try {
    return parseArgs({
      args: tokens,
      options: { ...GLOBAL_OPTION_SPEC, ...options },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    const message =
      error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
    throw new UsageError(`${message}.`.replace(/\.\.$/, "."), `Run "${helpCommand}" for usage.`);
  }
}

/** Returns the single value of a non-repeatable option given as `multiple`, rejecting repeats. */
export function single(values: readonly string[] | undefined, flag: string): string | undefined {
  if (!values || values.length === 0) return undefined;
  if (values.length > 1) throw new UsageError(`--${flag} may be given only once.`);
  return values[0];
}

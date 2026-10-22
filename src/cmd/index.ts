import type { ReportKind } from "../domain/filters.ts";
import {
  ConfigError,
  DevzyError,
  ExitCode,
  type ExitCodeValue,
  errorMessage,
  UsageError,
} from "../lib/errors.ts";
import { Logger } from "../lib/logger.ts";
import { type CliDeps, type CliIO, CommandContext, defaultDeps } from "./context.ts";
import { runHealthShow } from "./health.ts";
import {
  GLOBAL_HELP,
  HEALTH_HELP,
  HEALTH_SHOW_HELP,
  PM_HELP,
  PROVIDERS_ADD_HELP,
  PROVIDERS_HELP,
  PROVIDERS_LIST_HELP,
  reportHelp,
  VERSION,
} from "./help.ts";
import { runPmReport } from "./pm.ts";
import { runProvidersAdd, runProvidersList } from "./providers.ts";

type Handler = (ctx: CommandContext, tokens: string[]) => Promise<ExitCodeValue>;

interface Subcommand {
  help: string;
  run: Handler;
}

interface Group {
  help: string;
  /** Subcommand used when none is given (`devzy providers` → list). */
  defaultSubcommand?: string;
  subcommands: Record<string, Subcommand>;
}

const pm = (kind: ReportKind): Subcommand => ({
  help: reportHelp(kind),
  run: (ctx, tokens) => runPmReport(ctx, kind, tokens),
});

const GROUPS: Record<string, Group> = {
  pm: { help: PM_HELP, subcommands: { git: pm("git"), tasks: pm("tasks"), all: pm("all") } },
  providers: {
    help: PROVIDERS_HELP,
    defaultSubcommand: "list",
    subcommands: {
      list: { help: PROVIDERS_LIST_HELP, run: runProvidersList },
      add: { help: PROVIDERS_ADD_HELP, run: runProvidersAdd },
    },
  },
  health: {
    help: HEALTH_HELP,
    defaultSubcommand: "show",
    subcommands: { show: { help: HEALTH_SHOW_HELP, run: runHealthShow } },
  },
};

const HELP_FLAGS = new Set(["-h", "--help"]);

/**
 * CLI entry point. Parses the command path, dispatches to a handler and maps
 * errors to exit codes. Never throws.
 */
export async function run(
  argv: readonly string[],
  io: CliIO,
  deps: CliDeps = defaultDeps(),
): Promise<number> {
  const quiet = argv.includes("--quiet") || argv.includes("-q");
  const log = new Logger(io.stdout, io.stderr, { quiet });
  const interactive = Boolean(io.stdin.isTTY) && !argv.includes("--non-interactive");
  const ctx = new CommandContext(io, deps, log, interactive);

  try {
    return await dispatch(ctx, [...argv]);
  } catch (error) {
    return reportError(log, error);
  }
}

async function dispatch(ctx: CommandContext, tokens: string[]): Promise<ExitCodeValue> {
  const { log } = ctx;
  const path: string[] = [];
  while (path.length < 2 && tokens[0] !== undefined && !tokens[0].startsWith("-")) {
    path.push(tokens.shift() as string);
  }
  const wantsHelp = tokens.some((t) => HELP_FLAGS.has(t));
  const [first, second] = path;

  if (first === undefined) {
    if (tokens.includes("--version") || tokens.includes("-V")) {
      log.out(VERSION);
      return ExitCode.Success;
    }
    if (wantsHelp || tokens.length === 0) {
      log.out(GLOBAL_HELP);
      return ExitCode.Success;
    }
    throw new UsageError(`Unknown option "${tokens[0]}".`, 'Run "devzy help" for usage.');
  }

  if (first === "help") {
    if (second === undefined) {
      log.out(GLOBAL_HELP);
      return ExitCode.Success;
    }
    const group = GROUPS[second];
    if (!group) throw unknownCommand(second);
    log.out(group.help);
    return ExitCode.Success;
  }

  const group = GROUPS[first];
  if (!group) throw unknownCommand(first);

  if (second === "help") {
    log.out(group.help);
    return ExitCode.Success;
  }
  const subName = second ?? group.defaultSubcommand;
  if (subName === undefined) {
    if (wantsHelp) {
      log.out(group.help);
      return ExitCode.Success;
    }
    const names = Object.keys(group.subcommands).join(", ");
    throw new UsageError(
      `"devzy ${first}" needs a subcommand: ${names}.`,
      `Run "devzy ${first} help" for usage.`,
    );
  }
  const sub = group.subcommands[subName];
  if (!sub) {
    throw new UsageError(
      `Unknown command "devzy ${first} ${subName}".`,
      `Run "devzy ${first} help" for usage.`,
    );
  }
  if (wantsHelp) {
    log.out(second === undefined ? group.help : sub.help);
    return ExitCode.Success;
  }
  try {
    return await sub.run(ctx, tokens);
  } catch (error) {
    // Every usage error points at the relevant help.
    if (error instanceof UsageError && !error.hint) {
      throw new UsageError(error.message, `Run "devzy ${first} ${subName} --help" for usage.`);
    }
    throw error;
  }
}

function unknownCommand(name: string): UsageError {
  const known = [...Object.keys(GROUPS), "help"].join(", ");
  return new UsageError(
    `Unknown command "${name}". Available commands: ${known}.`,
    'Run "devzy help" for usage.',
  );
}

function reportError(log: Logger, error: unknown): number {
  if (error instanceof ConfigError) {
    log.error(error.message);
    for (const detail of error.details) log.diag(`  - ${detail}`);
    if (error.hint) log.diag(error.hint);
    return error.exitCode;
  }
  if (error instanceof DevzyError) {
    log.error(error.message);
    if (error.hint) log.diag(error.hint);
    return error.exitCode;
  }
  // Unexpected: show only the message (no stack) and redact it like everything else.
  log.error(`Unexpected error: ${errorMessage(error)}`);
  log.diag("This is likely a bug in devzy.");
  return ExitCode.Failure;
}

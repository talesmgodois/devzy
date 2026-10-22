import { FILTER_DEFINITIONS, FilterError } from "../domain/filters.ts";
import { ExitCode, type ExitCodeValue, UsageError } from "../lib/errors.ts";
import { renderTable } from "../lib/table.ts";
import { SETTINGS_LIMITS } from "../services/config/schema.ts";
import { FAILING_HEALTH_STATUSES, type HealthStatus, runHealthChecks } from "../services/health.ts";
import { parseCommandArgs, single } from "./args.ts";
import { type CommandContext, describeConfigSource } from "./context.ts";

const HEALTH_OPTION_SPEC = {
  provider: { type: "string", multiple: true },
  timeout: { type: "string", multiple: true },
} as const;

const STATUS_ORDER: HealthStatus[] = [
  "healthy",
  "unhealthy",
  "timeout",
  "error",
  "not_supported",
  "not_checked",
];

export async function runHealthShow(ctx: CommandContext, tokens: string[]): Promise<ExitCodeValue> {
  const values = parseCommandArgs(tokens, HEALTH_OPTION_SPEC, "devzy health help");
  const loaded = await ctx.config();
  const timeoutMs =
    parseTimeout(single(values.timeout, "timeout")) ?? loaded.config.settings.healthTimeoutMs;

  const providerDef = FILTER_DEFINITIONS.find((d) => d.key === "providers");
  let wanted: string[];
  try {
    wanted = (values.provider ?? []).map((v) => String(providerDef?.parse(v) ?? v));
  } catch (error) {
    if (error instanceof FilterError)
      throw new UsageError(error.message, 'Run "devzy health help" for usage.');
    throw error;
  }
  const entries = loaded.config.providers.filter(
    (e) => wanted.length === 0 || wanted.some((w) => w === e.id || w === e.type),
  );
  for (const value of wanted) {
    if (!loaded.config.providers.some((e) => e.id === value || e.type === value)) {
      throw new UsageError(
        `--provider ${value} does not match any configured provider ID or type.`,
        'Run "devzy providers list" to see configured providers.',
      );
    }
  }

  ctx.log.info(describeConfigSource(loaded));
  if (entries.length === 0) {
    ctx.log.out("No providers are configured, so there is nothing to check.");
    ctx.log.info('Run "devzy providers add" to add one.');
    return ExitCode.Success;
  }

  ctx.log.info(`Checking ${entries.length} provider(s) (timeout ${timeoutMs} ms each)...`);
  const rows = await runHealthChecks(await ctx.runtime(), entries, timeoutMs);

  ctx.log.out(
    renderTable(
      [
        { header: "Provider" },
        { header: "Name", flex: true },
        { header: "Category" },
        { header: "Mode" },
        { header: "Status" },
        { header: "Message", flex: true },
      ],
      rows.map((r) => [
        r.source.id,
        r.source.name,
        r.source.category,
        r.source.mode,
        r.status,
        r.message,
      ]),
      { maxWidth: ctx.log.terminalWidth },
    ),
  );
  if (rows.some((r) => r.source.mode === "mock" && r.status !== "not_checked")) {
    ctx.log.out("Mock providers report simulated health; they do not contact any service.");
  }

  const counts = STATUS_ORDER.map((s) => [s, rows.filter((r) => r.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  ctx.log.out();
  ctx.log.out(`Summary: ${counts.join(", ")}`);

  return rows.some((r) => FAILING_HEALTH_STATUSES.includes(r.status))
    ? ExitCode.Partial
    : ExitCode.Success;
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const [min, max] = SETTINGS_LIMITS.healthTimeoutMs;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new UsageError(
      `--timeout must be a whole number of milliseconds between ${min} and ${max}.`,
    );
  }
  return value;
}

/**
 * Reporting period shared by every report and provider.
 *
 * Convention: CLI dates are inclusive calendar dates in UTC. Internally the
 * period is a half-open interval `[since, until)` where `until` is midnight UTC
 * of the day *after* the inclusive end date. All conversion happens in
 * {@link periodFromDates}; nothing else should build a ReportingPeriod by hand.
 */
export interface ReportingPeriod {
  /** Inclusive start instant (00:00:00.000 UTC of the first day). */
  since: Date;
  /** Exclusive end instant (00:00:00.000 UTC of the day after the last day). */
  until: Date;
}

export const REPORTING_TIMEZONE = "UTC";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class PeriodError extends Error {
  override name = "PeriodError";
}

/** Parses a strict `YYYY-MM-DD` calendar date as midnight UTC. */
export function parseCalendarDate(value: string, label: string): Date {
  const match = ISO_DATE_RE.exec(value.trim());
  if (!match) {
    throw new PeriodError(`${label} must be a date in YYYY-MM-DD format (got "${value}").`);
  }
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new PeriodError(`${label} is not a valid calendar date (got "${value}").`);
  }
  return date;
}

export function formatCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export interface PeriodInput {
  since?: string | undefined;
  to?: string | undefined;
}

export interface ResolvedPeriod {
  period: ReportingPeriod;
  /** Inclusive first day, `YYYY-MM-DD`. */
  firstDay: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  lastDay: string;
  /** True when neither bound was supplied explicitly. */
  isDefault: boolean;
}

/**
 * Builds the reporting period from optional inclusive CLI dates.
 *
 * Defaults (with N = defaultDays):
 * - neither bound: the N calendar days ending today (UTC), today included.
 * - only `since`: from `since` through today.
 * - only `to`: the N calendar days ending on `to`.
 */
export function periodFromDates(
  input: PeriodInput,
  defaultDays: number,
  now: Date,
): ResolvedPeriod {
  if (!Number.isInteger(defaultDays) || defaultDays < 1) {
    throw new PeriodError("The default reporting period must be a positive whole number of days.");
  }
  const today = startOfUtcDay(now);
  const first =
    input.since !== undefined ? parseCalendarDate(input.since, "--dt-since") : undefined;
  const last = input.to !== undefined ? parseCalendarDate(input.to, "--dt-to") : undefined;

  const lastDay = last ?? today;
  const firstDay = first ?? addDays(lastDay, -(defaultDays - 1));

  if (firstDay.getTime() > lastDay.getTime()) {
    throw new PeriodError(
      `--dt-since (${formatCalendarDate(firstDay)}) must not be later than --dt-to (${formatCalendarDate(lastDay)}).`,
    );
  }

  return {
    period: { since: firstDay, until: addDays(lastDay, 1) },
    firstDay: formatCalendarDate(firstDay),
    lastDay: formatCalendarDate(lastDay),
    isDefault: first === undefined && last === undefined,
  };
}

export function isWithinPeriod(instant: Date, period: ReportingPeriod): boolean {
  const t = instant.getTime();
  return t >= period.since.getTime() && t < period.until.getTime();
}

/** Iterates the UTC calendar days covered by the period (each as midnight UTC). */
export function* daysInPeriod(period: ReportingPeriod): Generator<Date> {
  for (let t = startOfUtcDay(period.since).getTime(); t < period.until.getTime(); t += DAY_MS) {
    const day = new Date(t);
    if (day.getTime() >= period.since.getTime()) yield day;
  }
}

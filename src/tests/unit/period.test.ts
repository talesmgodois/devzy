import { describe, expect, test } from "bun:test";
import {
  daysInPeriod,
  isWithinPeriod,
  PeriodError,
  parseCalendarDate,
  periodFromDates,
} from "../../domain/period.ts";

const NOW = new Date("2026-10-22T15:30:00Z");

describe("parseCalendarDate", () => {
  test("parses YYYY-MM-DD as midnight UTC", () => {
    expect(parseCalendarDate("2026-01-31", "x").toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  test.each(["2026-1-01", "20260101", "2026-01-01T00:00", "Jan 1 2026", "", "2026/01/01"])(
    "rejects malformed %p",
    (value) => {
      expect(() => parseCalendarDate(value, "--dt-since")).toThrow(PeriodError);
    },
  );

  test.each(["2026-02-30", "2026-13-01", "2025-02-29", "2026-00-10"])(
    "rejects impossible date %p",
    (value) => {
      expect(() => parseCalendarDate(value, "--dt-to")).toThrow(/not a valid calendar date/);
    },
  );

  test("accepts leap day", () => {
    expect(parseCalendarDate("2028-02-29", "x").getUTCDate()).toBe(29);
  });
});

describe("periodFromDates", () => {
  test("explicit dates are inclusive and stored as a half-open interval", () => {
    const r = periodFromDates({ since: "2026-01-01", to: "2026-01-31" }, 30, NOW);
    expect(r.period.since.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(r.period.until.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(r.firstDay).toBe("2026-01-01");
    expect(r.lastDay).toBe("2026-01-31");
    expect(r.isDefault).toBe(false);
  });

  test("default is the N days ending today (UTC), inclusive", () => {
    const r = periodFromDates({}, 30, NOW);
    expect(r.firstDay).toBe("2026-09-23");
    expect(r.lastDay).toBe("2026-10-22");
    expect(r.isDefault).toBe(true);
    expect([...daysInPeriod(r.period)]).toHaveLength(30);
  });

  test("only --dt-since runs through today", () => {
    const r = periodFromDates({ since: "2026-10-01" }, 30, NOW);
    expect(r.lastDay).toBe("2026-10-22");
  });

  test("only --dt-to covers N days ending on it", () => {
    const r = periodFromDates({ to: "2026-03-10" }, 7, NOW);
    expect(r.firstDay).toBe("2026-03-04");
    expect(r.lastDay).toBe("2026-03-10");
  });

  test("single-day period", () => {
    const r = periodFromDates({ since: "2026-05-05", to: "2026-05-05" }, 30, NOW);
    expect([...daysInPeriod(r.period)].map((d) => d.toISOString())).toEqual([
      "2026-05-05T00:00:00.000Z",
    ]);
  });

  test("rejects start after end", () => {
    expect(() => periodFromDates({ since: "2026-02-02", to: "2026-02-01" }, 30, NOW)).toThrow(
      /must not be later/,
    );
  });

  test("rejects only --dt-since in the future", () => {
    expect(() => periodFromDates({ since: "2027-01-01" }, 30, NOW)).toThrow(PeriodError);
  });

  test("boundaries: last millisecond of the end day is inside, next midnight is outside", () => {
    const { period } = periodFromDates({ since: "2026-01-01", to: "2026-01-31" }, 30, NOW);
    expect(isWithinPeriod(new Date("2026-01-01T00:00:00.000Z"), period)).toBe(true);
    expect(isWithinPeriod(new Date("2025-12-31T23:59:59.999Z"), period)).toBe(false);
    expect(isWithinPeriod(new Date("2026-01-31T23:59:59.999Z"), period)).toBe(true);
    expect(isWithinPeriod(new Date("2026-02-01T00:00:00.000Z"), period)).toBe(false);
  });
});

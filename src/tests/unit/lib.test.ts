import { describe, expect, test } from "bun:test";
import { Logger } from "../../lib/logger.ts";
import { REDACTED, Redactor } from "../../lib/redact.ts";
import { displayWidth, formatCount, renderTable, truncate } from "../../lib/table.ts";

describe("Redactor", () => {
  test("removes registered secrets and known token shapes", () => {
    const r = new Redactor();
    r.register("s3cr3t-value");
    r.register("abc"); // too short to register safely
    expect(r.redact("token s3cr3t-value here")).toBe(`token ${REDACTED} here`);
    expect(r.redact("abc")).toBe("abc");
    expect(r.redact("x ghp_abcdefghijklmnopqrstuvwxyz0123 y")).toBe(`x ${REDACTED} y`);
    expect(r.redact("glpat-abcdefghijklmnopqrstu")).toBe(REDACTED);
    expect(r.redact("Authorization: Bearer abc.def-ghi_jkl")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(r.redact("Set the token in GITHUB_TOKEN")).toBe("Set the token in GITHUB_TOKEN");
  });

  test("logger redacts every channel", () => {
    let out = "";
    let err = "";
    const log = new Logger(
      { write: (s: string) => (out += s) },
      { write: (s: string) => (err += s) },
    );
    log.redactor.register("supersecret");
    log.out("a supersecret b");
    log.error("failed with supersecret");
    log.warn("supersecret");
    log.info("supersecret");
    expect(out + err).not.toContain("supersecret");
  });

  test("quiet hides info but not warnings or errors", () => {
    let err = "";
    const log = new Logger(
      { write: () => true },
      { write: (s: string) => (err += s) },
      { quiet: true },
    );
    log.info("progress");
    log.warn("careful");
    log.error("bad");
    expect(err).toBe("warning: careful\nerror: bad\n");
  });
});

describe("renderTable", () => {
  const columns = [
    { header: "Name", flex: true },
    { header: "Count", align: "right" as const },
  ];

  test("aligns columns and right-aligns numbers", () => {
    expect(
      renderTable(columns, [
        ["Ana", "12"],
        ["Benjamin", "3"],
      ]),
    ).toBe(["Name      Count", "--------  -----", "Ana          12", "Benjamin      3"].join("\n"));
  });

  test("truncates flexible columns on narrow terminals, never numeric ones", () => {
    const text = renderTable(columns, [["A very long contributor name", "1234"]], { maxWidth: 20 });
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(20);
    expect(text).toContain("…");
    expect(text).toContain("1234");
  });

  test("aligns wide (CJK/emoji) characters by display width", () => {
    const text = renderTable(columns, [
      ["王小明", "1"],
      ["Ana 🚀", "22"],
    ]);
    // Every line ends at the same terminal column when widths are measured correctly.
    expect(new Set(text.split("\n").map(displayWidth)).size).toBe(1);
    expect(text.split("\n")[2]).toBe("王小明      1");
    expect(displayWidth("王小明")).toBe(6);
    expect(displayWidth("\u001b[31mred\u001b[0m")).toBe(3);
  });

  test("helpers", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(formatCount(undefined)).toBe("-");
    expect(formatCount(12345)).toBe("12,345");
  });
});

import stringWidth from "string-width";

export interface Column {
  header: string;
  align?: "left" | "right";
  /** May be truncated with an ellipsis when the table is wider than the terminal. */
  flex?: boolean;
}

export interface TableOptions {
  /** Maximum line width. Undefined disables truncation (e.g. when piping). */
  maxWidth?: number | undefined;
}

const GAP = "  ";
const ELLIPSIS = "…";
const MIN_FLEX_WIDTH = 6;

/** Terminal column width (wide CJK/emoji characters count as 2, ANSI codes as 0). */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return ELLIPSIS.slice(0, width);
  let out = "";
  for (const char of text) {
    if (displayWidth(out + char) > width - 1) break;
    out += char;
  }
  return out + ELLIPSIS;
}

function pad(text: string, width: number, align: "left" | "right"): string {
  const fill = " ".repeat(Math.max(0, width - displayWidth(text)));
  return align === "right" ? fill + text : text + fill;
}

/**
 * Renders a plain-text table: a header row, a dashed rule and the data rows.
 * On narrow terminals flexible columns shrink (widest first) and their cells
 * are truncated; numeric columns are never truncated.
 */
export function renderTable(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  options: TableOptions = {},
): string {
  const widths = columns.map((col, i) =>
    Math.max(displayWidth(col.header), ...rows.map((r) => displayWidth(r[i] ?? ""))),
  );

  if (options.maxWidth !== undefined) {
    const total = () => widths.reduce((a, b) => a + b, 0) + GAP.length * (columns.length - 1);
    let excess = total() - options.maxWidth;
    while (excess > 0) {
      let widest = -1;
      columns.forEach((col, i) => {
        const w = widths[i] ?? 0;
        const floor = Math.max(MIN_FLEX_WIDTH, Math.min(displayWidth(col.header), 12));
        if (col.flex && w > floor && (widest === -1 || w > (widths[widest] ?? 0))) widest = i;
      });
      if (widest === -1) break;
      widths[widest] = (widths[widest] ?? 0) - 1;
      excess -= 1;
    }
  }

  const line = (cells: readonly string[]) =>
    columns
      .map((col, i) => {
        const width = widths[i] ?? 0;
        return pad(truncate(cells[i] ?? "", width), width, col.align ?? "left");
      })
      .join(GAP)
      .trimEnd();

  return [
    line(columns.map((c) => c.header)),
    widths.map((w) => "-".repeat(w)).join(GAP),
    ...rows.map(line),
  ].join("\n");
}

export function formatCount(value: number | undefined): string {
  return value === undefined ? "-" : value.toLocaleString("en-US");
}

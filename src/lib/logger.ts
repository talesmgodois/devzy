import { Redactor } from "./redact.ts";

export interface OutputStream {
  write(chunk: string): unknown;
  isTTY?: boolean | undefined;
  columns?: number | undefined;
}

export interface LoggerOptions {
  /** Suppress informational stderr messages (warnings and errors are still shown). */
  quiet?: boolean;
}

/**
 * Terminal output. Report content goes to stdout; diagnostics go to stderr.
 * Every line passes through the redactor, so registered secrets and common
 * token formats can never be printed.
 */
export class Logger {
  readonly redactor: Redactor;
  quiet: boolean;

  constructor(
    readonly stdout: OutputStream,
    readonly stderr: OutputStream,
    options: LoggerOptions = {},
    redactor: Redactor = new Redactor(),
  ) {
    this.quiet = options.quiet ?? false;
    this.redactor = redactor;
  }

  /** Report output (stdout). */
  out(text = ""): void {
    this.stdout.write(`${this.redactor.redact(text)}\n`);
  }

  /** Progress or context (stderr); hidden with --quiet. */
  info(text: string): void {
    if (!this.quiet) this.stderr.write(`${this.redactor.redact(text)}\n`);
  }

  warn(text: string): void {
    this.stderr.write(`warning: ${this.redactor.redact(text)}\n`);
  }

  error(text: string): void {
    this.stderr.write(`error: ${this.redactor.redact(text)}\n`);
  }

  /** Raw stderr line without a prefix (used for help hints and prompts). */
  diag(text: string): void {
    this.stderr.write(`${this.redactor.redact(text)}\n`);
  }

  get terminalWidth(): number | undefined {
    return this.stdout.isTTY ? this.stdout.columns : undefined;
  }
}

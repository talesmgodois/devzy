import { createInterface, type Interface } from "node:readline";
import { CancelledError } from "./errors.ts";
import type { OutputStream } from "./logger.ts";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

export interface AskOptions {
  default?: string | undefined;
  /** Returns an error message for invalid input, or undefined when valid. */
  validate?: (value: string) => string | undefined;
}

/**
 * Minimal line-based prompts. Questions are written to the given output
 * (stderr in the CLI) so stdout stays clean. End of input (Ctrl+D) or typing
 * "cancel" aborts with {@link CancelledError}. Used only when stdin is a TTY.
 */
export class Prompter {
  readonly #rl: Interface;
  readonly #lines: AsyncIterator<string>;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: OutputStream,
  ) {
    this.#rl = createInterface({ input, terminal: false });
    this.#lines = this.#rl[Symbol.asyncIterator]();
  }

  async #readLine(prompt: string): Promise<string> {
    this.output.write(prompt);
    const next = await this.#lines.next();
    if (next.done) {
      this.output.write("\n");
      throw new CancelledError();
    }
    const value = next.value.trim();
    if (value.toLowerCase() === "cancel") throw new CancelledError();
    return value;
  }

  async ask(question: string, options: AskOptions = {}): Promise<string> {
    const suffix = options.default ? ` [${options.default}]` : "";
    for (;;) {
      const answer = (await this.#readLine(`${question}${suffix}: `)) || options.default || "";
      const problem = options.validate?.(answer);
      if (!problem) return answer;
      this.output.write(`  ${problem}\n`);
    }
  }

  async choose<T extends string>(question: string, choices: readonly Choice<T>[]): Promise<T> {
    this.output.write(`${question}\n`);
    choices.forEach((choice, i) => {
      this.output.write(`  ${String(i + 1).padStart(2)}) ${choice.label}\n`);
    });
    for (;;) {
      const answer = await this.#readLine(`Choose 1-${choices.length} (or type "cancel"): `);
      const index = Number(answer);
      const byIndex = Number.isInteger(index) ? choices[index - 1] : undefined;
      const byValue = choices.find((c) => c.value === answer.toLowerCase());
      const picked = byIndex ?? byValue;
      if (picked) return picked.value;
      this.output.write(`  Please enter a number between 1 and ${choices.length}.\n`);
    }
  }

  async confirm(question: string, defaultValue = false): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N";
    for (;;) {
      const answer = (await this.#readLine(`${question} [${hint}]: `)).toLowerCase();
      if (answer === "") return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      this.output.write('  Please answer "y" or "n".\n');
    }
  }

  close(): void {
    this.#rl.close();
  }
}

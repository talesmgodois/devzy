#!/usr/bin/env node
import { run } from "../cmd/index.ts";
import { Redactor } from "../lib/redact.ts";

// Reading stops early (e.g. `devzy pm all | head`): exit quietly instead of
// crashing with an EPIPE stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

// Last-resort handlers: `run` already maps expected errors to exit codes, so
// these only fire on bugs. Print one line, never a stack trace or secrets.
const fatal = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: Unexpected failure: ${new Redactor().redact(message)}\n`);
  process.exit(1);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

// Set the exit code instead of calling process.exit() so buffered output on
// pipes is flushed before the process ends.
process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
});

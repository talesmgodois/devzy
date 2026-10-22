#!/usr/bin/env bun
import { run } from "../cmd/index.ts";

const code = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
});
process.exit(code);

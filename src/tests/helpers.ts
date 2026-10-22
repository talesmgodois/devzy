import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { type CliDeps, defaultDeps, type InputStream } from "../cmd/context.ts";
import { run } from "../cmd/index.ts";
import type { OutputStream } from "../lib/logger.ts";

export const BIN = resolve(import.meta.dir, "../bin/devzy.ts");

/** A temporary directory removed by `cleanup`. */
export async function makeTempDir(
  prefix = "devzy-test-",
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** Isolated environment: no inherited config paths or tokens. */
export function isolatedEnv(
  home: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, NO_COLOR: "1", ...extra };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the real binary in a subprocess (stdin is a pipe, so it is never a TTY). */
export async function spawnCli(
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

class Capture implements OutputStream {
  text = "";
  isTTY = false;
  columns: number | undefined = undefined;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/**
 * Runs the CLI in-process. `stdinLines` (when given) are fed to a stream that
 * reports itself as a TTY, to exercise interactive prompts.
 */
export async function runInProcess(
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdinLines?: string[];
    deps?: Partial<CliDeps>;
  },
): Promise<CliResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const stdin = new PassThrough() as PassThrough & InputStream;
  if (options.stdinLines) {
    stdin.isTTY = true;
    stdin.end(options.stdinLines.map((l) => `${l}\n`).join(""));
  } else {
    stdin.end();
  }
  const code = await run(
    args,
    { stdout, stderr, stdin, env: options.env, cwd: options.cwd },
    { ...defaultDeps(), ...options.deps },
  );
  return { code, stdout: stdout.text, stderr: stderr.text };
}

export const SEPTEMBER = ["--dt-since", "2026-09-01", "--dt-to", "2026-09-30"];

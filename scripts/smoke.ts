/**
 * Smoke-tests the npm package as users get it.
 *
 *   bun scripts/smoke.ts [path/to/devzy-x.y.z.tgz]
 *
 * Packs the repository (or uses the given tarball), installs it with npm into
 * a temporary directory outside the repository, and runs the installed
 * `devzy` executable under Node.js with Bun removed from PATH, a fresh HOME
 * and no devzy configuration or credentials.
 *
 * Node is taken from $SMOKE_NODE or PATH and must be >= 22. Installing the
 * package needs the npm registry (for its declared dependencies); devzy
 * itself only runs in mock mode, so no provider is contacted.
 */
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const isWindows = process.platform === "win32";
const MIN_NODE_MAJOR = 22;

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
};

function fail(message: string): never {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

// --- Node to test with --------------------------------------------------------
const nodeBin = process.env["SMOKE_NODE"] ?? "node";
const nodeInfo = spawnSync(
  nodeBin,
  ["-p", "JSON.stringify([process.versions.node, process.execPath])"],
  {
    encoding: "utf8",
  },
);
if (nodeInfo.status !== 0)
  fail(`cannot run Node (${nodeBin}); set SMOKE_NODE to a Node >= ${MIN_NODE_MAJOR} binary.`);
const [nodeVersion, nodePath] = JSON.parse(nodeInfo.stdout) as [string, string];
if (Number(nodeVersion.split(".")[0]) < MIN_NODE_MAJOR) {
  fail(`Node ${nodeVersion} is below the supported minimum (${MIN_NODE_MAJOR}); set SMOKE_NODE.`);
}
const nodeDir = dirname(nodePath);
// npm next to the chosen Node (nvm, setup-node), else whatever is on PATH.
const bundledNpm = join(nodeDir, isWindows ? "npm.cmd" : "npm");
const npmCli = existsSync(bundledNpm) ? bundledNpm : "npm";

// PATH without any directory that contains Bun, with the chosen Node first.
const hasBun = (dir: string) => ["bun", "bun.exe"].some((b) => existsSync(join(dir, b)));
const pathDirs = [nodeDir, ...(process.env["PATH"] ?? "").split(delimiter)].filter(
  (dir, i, all) => dir && all.indexOf(dir) === i && !hasBun(dir),
);
const runPath = pathDirs.join(delimiter);

// --- Workspace ---------------------------------------------------------------
const work = await mkdtemp(join(tmpdir(), "devzy-smoke-"));
const app = join(work, "app");
const home = join(work, "home");
const cwd = join(work, "cwd");
await Promise.all([mkdir(app), mkdir(home), mkdir(cwd)]);

const installEnv = { ...process.env, PATH: [nodeDir, process.env["PATH"] ?? ""].join(delimiter) };

let tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!tarball) {
  if (!existsSync(join(root, "dist/devzy.js")))
    fail("dist/devzy.js is missing; run `bun run build` first.");
  const pack = spawnSync(
    npmCli,
    ["pack", "--ignore-scripts", "--pack-destination", work, "--json"],
    {
      cwd: root,
      env: installEnv,
      encoding: "utf8",
      shell: isWindows,
    },
  );
  if (pack.status !== 0) fail(`npm pack failed:\n${pack.stderr}`);
  const [{ filename }] = JSON.parse(pack.stdout) as [{ filename: string }];
  tarball = join(work, filename);
}
if (!existsSync(tarball)) fail(`tarball not found: ${tarball}`);

await writeFile(join(app, "package.json"), JSON.stringify({ name: "devzy-smoke", private: true }));
const install = spawnSync(
  npmCli,
  ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball],
  {
    cwd: app,
    env: installEnv,
    encoding: "utf8",
    shell: isWindows,
  },
);
if (install.status !== 0) fail(`npm install failed:\n${install.stderr}`);

const binDir = join(app, "node_modules", ".bin");
const devzyBin = join(binDir, isWindows ? "devzy.cmd" : "devzy");
if (!existsSync(devzyBin))
  fail(`installed executable not found: ${devzyBin} (bin dir: ${readdirSync(binDir).join(", ")})`);

// --- Running devzy -----------------------------------------------------------
const baseEnv: Record<string, string> = {
  PATH: runPath,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData"),
  ...(isWindows ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}),
};

function devzy(args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(devzyBin, args, {
    cwd,
    env: { ...baseEnv, ...env },
    encoding: "utf8",
    shell: isWindows,
    timeout: 60_000,
  });
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, r?: SpawnSyncReturns<string>): void {
  const detail =
    ok || !r ? undefined : `exit=${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
  results.push({ name, ok, ...(detail ? { detail } : {}) });
}
const noStack = (r: SpawnSyncReturns<string>) => !/\n\s+at /.test(r.stderr);

const which = spawnSync(
  isWindows ? "where" : "sh",
  isWindows ? ["bun"] : ["-c", "command -v bun"],
  {
    env: baseEnv,
    encoding: "utf8",
  },
);
check("bun is not available to devzy", which.status !== 0);

let r = devzy(["--help"]);
check(
  "--help exits 0 and prints usage",
  r.status === 0 && r.stdout.includes("Usage:") && r.stderr === "",
  r,
);

r = devzy(["--version"]);
check(`--version prints ${pkg.version}`, r.status === 0 && r.stdout.trim() === pkg.version, r);

r = devzy(["pm", "all", "--dt-since", "2026-01-01", "--dt-to", "2026-01-31"]);
check(
  "pm all runs in mock mode with the built-in demo config",
  r.status === 0 && r.stdout.includes("MOCK DATA") && r.stdout.includes("Ana Souza") && noStack(r),
  r,
);

r = devzy(["providers"]);
check("providers list exits 0", r.status === 0 && r.stdout.includes("Known provider types"), r);

r = devzy(["health"]);
check("health exits 0", r.status === 0 && r.stdout.includes("Summary: 4 healthy"), r);

const badConfig = join(work, "bad.yaml");
await writeFile(badConfig, "providers: [\n");
r = devzy(["providers"], { DEVZY_CONFIG_PATH: badConfig });
check(
  "invalid config exits 4 with a useful message",
  r.status === 4 && r.stderr.includes("Malformed YAML") && r.stdout === "" && noStack(r),
  r,
);

r = devzy(["frobnicate"]);
check(
  "unknown command exits 2 on stderr",
  r.status === 2 && r.stdout === "" && r.stderr.includes("Unknown command"),
  r,
);

// Large piped output must be complete (exit code set without truncating stdout).
const many = join(work, "many.yaml");
const count = 1500;
await writeFile(
  many,
  `providers:\n${Array.from({ length: count }, (_, i) => `  - { id: p${i}, type: jira, name: "Provider ${i}", mode: mock }`).join("\n")}\n`,
);
r = devzy(["providers"], { DEVZY_CONFIG_PATH: many });
const listed = r.stdout.split("\n").filter((line) => /^p\d+\s/.test(line)).length;
check(
  `large piped output is complete (${count} providers, ${(r.stdout.length / 1024).toFixed(0)} KiB)`,
  r.status === 0 && listed === count && r.stdout.trimEnd().endsWith("to check providers."),
  r,
);

// Closing the reader early (like `| head -1`) must not crash with EPIPE.
// POSIX only: on Windows the npm .cmd shim sits between the pipe and Node.
if (!isWindows) {
  const epipe = await new Promise<{ code: number | null; stderr: string }>((resolveRun) => {
    const child = spawn(devzyBin, ["providers"], {
      cwd,
      env: { ...baseEnv, DEVZY_CONFIG_PATH: many },
      shell: isWindows,
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdout.once("data", () => child.stdout.destroy());
    child.on("close", (code) => resolveRun({ code, stderr }));
  });
  check(
    "closing stdout early exits quietly",
    epipe.code === 0 && !/EPIPE|\n\s+at /.test(epipe.stderr),
    { status: epipe.code, stdout: "", stderr: epipe.stderr } as SpawnSyncReturns<string>,
  );
}

// The live HTTP path (fetch, timeouts, auth headers) under Node, against a
// local fake GitLab: no external network, a dummy token.
const fakeToken = "glpat-smoke-dummy-token-000000";
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const authorized = req.headers["private-token"] === fakeToken;
  res.setHeader("content-type", "application/json");
  if (!authorized) {
    res.statusCode = 401;
    res.end("{}");
  } else if (url.pathname === "/api/v4/projects/acme%2Fapi/repository/commits") {
    res.setHeader("x-next-page", "");
    res.end(
      JSON.stringify([
        {
          author_name: "Ana",
          author_email: "ana@example.com",
          committed_date: "2026-01-10T10:00:00Z",
        },
        {
          author_name: "Ana",
          author_email: "ana@example.com",
          committed_date: "2026-01-11T10:00:00Z",
        },
      ]),
    );
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
});
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
const port = (server.address() as AddressInfo).port;
const liveConfig = join(work, "live.yaml");
await writeFile(
  liveConfig,
  `providers:\n  - id: gl\n    type: gitlab\n    name: GitLab\n    mode: live\n    options: { baseUrl: "http://127.0.0.1:${port}", projects: [acme/api] }\n`,
);
const liveRun = (env: Record<string, string>) =>
  new Promise<SpawnSyncReturns<string>>((done) => {
    const child = spawn(
      devzyBin,
      ["pm", "git", "--dt-since", "2026-01-01", "--dt-to", "2026-01-31"],
      {
        cwd,
        env: { ...baseEnv, DEVZY_CONFIG_PATH: liveConfig, ...env },
        shell: isWindows,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (status) => done({ status, stdout, stderr } as SpawnSyncReturns<string>));
  });
r = await liveRun({ GITLAB_TOKEN: fakeToken });
check(
  "live GitLab adapter works under Node (local fake server)",
  r.status === 0 && /Ana\s+email\s+2\s+1\s+gl/.test(r.stdout),
  r,
);
r = await liveRun({ GITLAB_TOKEN: "glpat-wrong-token-0000000000" });
check(
  "live auth failure is a partial/failed report without the token",
  r.status === 1 &&
    r.stderr.includes("HTTP 401") &&
    !(r.stdout + r.stderr).includes("glpat-wrong-token"),
  r,
);
server.close();

// --- Report -------------------------------------------------------------------
console.log(
  `devzy smoke test: ${pkg.name}@${pkg.version} on Node ${nodeVersion} (${process.platform})`,
);
for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}`);
  if (result.detail) console.log(result.detail.replace(/^/gm, "      "));
}
await rm(work, { recursive: true, force: true }).catch(() => undefined);
const failed = results.filter((x) => !x.ok).length;
if (failed > 0) fail(`${failed} check(s) failed.`);
console.log("All smoke checks passed.");

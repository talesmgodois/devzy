/**
 * Verifies the npm tarball contents without publishing:
 * exactly the allowlisted files, all required files present, and no
 * credential-like strings in any packed file. Run after `bun run build`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const REQUIRED = ["package.json", "README.md", "LICENSE", "dist/devzy.js"];
const OPTIONAL = ["devzy.example.yaml"];
const SECRET_PATTERNS: [string, RegExp][] = [
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["Linear key", /\blin_api_[A-Za-z0-9]{30,}\b/],
  ["Atlassian token", /\bATATT[A-Za-z0-9_\-=]{30,}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
];

if (!existsSync(join(root, "dist/devzy.js"))) {
  console.error("dist/devzy.js is missing; run `bun run build` first.");
  process.exit(1);
}

const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (pack.status !== 0) {
  console.error(pack.stderr);
  process.exit(1);
}
const [info] = JSON.parse(pack.stdout) as [
  { name: string; version: string; size: number; unpackedSize: number; files: { path: string }[] },
];
const files = info.files.map((f) => f.path.replace(/\\/g, "/")).sort();

const errors: string[] = [];
for (const file of REQUIRED)
  if (!files.includes(file)) errors.push(`missing required file: ${file}`);
for (const file of files) {
  if (!REQUIRED.includes(file) && !OPTIONAL.includes(file))
    errors.push(`unexpected file in package: ${file}`);
  const text = readFileSync(join(root, file), "utf8");
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) errors.push(`${file} contains something that looks like a ${label}`);
  }
}
const bin = readFileSync(join(root, "dist/devzy.js"), "utf8");
if (!bin.startsWith("#!/usr/bin/env node\n"))
  errors.push("dist/devzy.js must start with a Node shebang");

console.log(
  `${info.name}@${info.version}: ${files.length} files, ${(info.size / 1024).toFixed(1)} KiB packed, ${(info.unpackedSize / 1024).toFixed(1)} KiB unpacked`,
);
for (const file of files) console.log(`  ${file}`);
if (errors.length > 0) {
  console.error(`\nPackage check failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log("Package contents OK.");

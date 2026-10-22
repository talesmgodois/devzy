/**
 * Builds the npm executable: dist/devzy.js, one Node.js ESM file.
 *
 * - Runtime dependencies stay external (installed by npm from package.json).
 * - The Bun shebang/pragma emitted by the bundler is replaced with a Node one.
 * - Fails if the output uses Bun-only APIs or imports undeclared packages.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outDir = join(root, "dist");
const outFile = join(outDir, "devzy.js");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const declared = new Set(Object.keys(pkg.dependencies ?? {}));

await rm(outDir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(root, "src/bin/devzy.ts")],
  target: "node",
  format: "esm",
  packages: "external",
  sourcemap: "none",
  minify: false,
});
if (!result.success || result.outputs.length !== 1) {
  for (const log of result.logs) console.error(log);
  throw new Error("Build failed.");
}

const bundled = await (result.outputs[0] as Blob).text();
const body = bundled
  .split("\n")
  .filter((line, i) => !(i < 3 && (line.startsWith("#!") || line.trim() === "// @bun")))
  .join("\n");
const code = `#!/usr/bin/env node\n${body}`;

const problems: string[] = [];
if (/\bBun\.[A-Za-z]/.test(code)) problems.push("uses a Bun-only API (Bun.*)");
if (/from\s+["']bun(:[a-z]+)?["']/.test(code)) problems.push('imports from "bun"');
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
for (const [, spec] of code.matchAll(/(?:from|import)\s*\(?\s*["']([^"'.][^"']*)["']/g)) {
  if (!spec || builtins.has(spec) || spec.startsWith("node:")) continue;
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  if (!name || !declared.has(name)) problems.push(`imports undeclared package "${spec}"`);
}
if (problems.length > 0) {
  throw new Error(
    `dist/devzy.js is not Node-compatible:\n- ${[...new Set(problems)].join("\n- ")}`,
  );
}

await mkdir(outDir, { recursive: true });
await writeFile(outFile, code, "utf8");
await chmod(outFile, 0o755);
console.log(`Built ${outFile} (${(code.length / 1024).toFixed(1)} KiB)`);

import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Document, isMap, isSeq, parseDocument } from "yaml";
import { ConfigError, DevzyError, errorMessage } from "../../lib/errors.ts";
import { parseConfigText } from "./load.ts";
import type { ConfigFile, ProviderEntryInput } from "./schema.ts";

export interface AppendProviderOptions {
  path: string;
  entry: ProviderEntryInput;
  /**
   * Called with the would-be file contents before anything is written. Throw
   * to abort (e.g. when the merged configuration would be invalid).
   */
  validate?: (data: ConfigFile) => void;
}

/**
 * Appends a provider entry to a configuration file while preserving the
 * rest of the file (other entries, settings, comments).
 *
 * Safety:
 * - an existing file that is not valid devzy YAML is never modified;
 * - the resulting text is re-parsed and validated before it is written;
 * - the write is atomic (temporary file in the same directory + rename);
 * - parent directories are created with mode 0700 and the file with 0600.
 */
export async function appendProviderToFile(options: AppendProviderOptions): Promise<void> {
  const { path, entry } = options;
  const existing = await readExisting(path);

  let doc: Document;
  if (existing === undefined || existing.trim() === "") {
    doc = new Document({ version: 1, providers: [] });
  } else {
    // Validates the current file; throws without touching it if invalid.
    parseConfigText(existing, path);
    doc = parseDocument(existing);
    if (!isMap(doc.contents)) {
      throw new ConfigError(`Refusing to modify ${path}: the top level is not a mapping.`);
    }
  }

  const providers = doc.get("providers");
  if (providers === undefined || providers === null) {
    doc.set("providers", doc.createNode([entry]));
  } else if (isSeq(providers)) {
    providers.add(doc.createNode(entry));
  } else {
    throw new ConfigError(`Refusing to modify ${path}: "providers" is not a list.`);
  }

  const text = doc.toString();
  const data = parseConfigText(text, path);
  options.validate?.(data);
  await writeFileAtomic(path, text);
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`Could not read ${path}: ${errorMessage(error)}`);
  }
}

/** Writes via a temporary sibling file and rename, so readers never see a partial file. */
export async function writeFileAtomic(path: string, text: string, mode = 0o600): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new DevzyError(`Could not create directory for ${path}: ${errorMessage(error)}`);
  }
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, mode).catch(() => undefined); // umask may have widened/narrowed it; best effort.
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new DevzyError(`Could not write ${path}: ${errorMessage(error)}`);
  }
}

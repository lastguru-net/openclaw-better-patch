// Adapted from OpenAI Codex rust-v0.153.4 (Apache-2.0). See NOTICE.
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parsePatch, trim, trimEnd, type Chunk } from "./parser.js";

const normalize = (s: string): string => trim(s)
  .replace(/[\u2010-\u2015\u2212]/gu, "-")
  .replace(/[\u2018-\u201b]/gu, "'")
  .replace(/[\u201c-\u201f]/gu, '"')
  .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu, " ");

function seek(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return undefined;
  const from = eof ? lines.length - pattern.length : start;
  for (const transform of [(s: string) => s, trimEnd, trim, normalize]) {
    for (let i = from; i <= lines.length - pattern.length; i++) {
      if (pattern.every((line, j) => transform(lines[i + j]) === transform(line))) return i;
    }
  }
  return undefined;
}

function update(contents: string, chunks: Chunk[], path: string): string {
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements: { start: number; count: number; lines: string[] }[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const found = seek(lines, [chunk.context], cursor, false);
      if (found === undefined) throw new Error(`Failed to find context '${chunk.context}' in ${path}`);
      cursor = found + 1;
    }
    if (!chunk.old.length) {
      replacements.push({ start: lines.at(-1) === "" ? lines.length - 1 : lines.length,
        count: 0, lines: chunk.replacement });
      continue;
    }
    let pattern = chunk.old;
    let newLines = chunk.replacement;
    let found = seek(lines, pattern, cursor, chunk.eof);
    if (found === undefined && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = seek(lines, pattern, cursor, chunk.eof);
    }
    if (found === undefined) throw new Error(`Failed to find expected lines in ${path}:\n${chunk.old.join("\n")}`);
    replacements.push({ start: found, count: pattern.length, lines: newLines });
    cursor = found + pattern.length;
  }
  replacements.sort((a, b) => a.start - b.start);
  // Avoid spreading arbitrarily large patches into function arguments.
  let result = lines;
  for (const replacement of replacements.reverse()) {
    result = result.slice(0, replacement.start).concat(replacement.lines, result.slice(replacement.start + replacement.count));
  }
  if (result.at(-1) !== "") result.push("");
  return result.join("\n");
}

async function writeWithParents(path: string, contents: string): Promise<void> {
  try { await writeFile(path, contents); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

export type PatchResult = { text: string; added: string[]; modified: string[]; deleted: string[] };

/** The patch algorithm operates on either host files or an OpenClaw sandbox bridge. */
export interface PatchFileSystem {
  resolve(cwd: string, path: string): string;
  read(path: string): Promise<Uint8Array>;
  write(path: string, contents: string, createParents: boolean): Promise<void>;
  remove(path: string): Promise<void>;
}

export const hostFileSystem: PatchFileSystem = {
  resolve,
  read: readFile,
  write: (path, contents, createParents) => createParents ? writeWithParents(path, contents) : writeFile(path, contents),
  async remove(path) {
    if ((await stat(path)).isDirectory()) throw new Error(`path is a directory: ${path}`);
    await unlink(path);
  },
};

async function readText(path: string, fs: PatchFileSystem): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await fs.read(path));
}

/** Native-tool correctness checks, without Codex's approval/executor machinery. */
export async function applyVerifiedPatch(patch: string, cwd: string, checkPath?: (path: string) => Promise<void>, fs: PatchFileSystem = hostFileSystem): Promise<PatchResult> {
  const seen = new Set<string>();
  for (const hunk of parsePatch(patch)) {
    const path = fs.resolve(cwd, hunk.path);
    await checkPath?.(path);
    if (hunk.kind === "update" && hunk.move !== undefined) await checkPath?.(fs.resolve(cwd, hunk.move));
    if (seen.has(path)) throw new Error(`Invalid patch: multiple operations target ${path}`);
    seen.add(path);
    if (hunk.kind !== "add") {
      let contents: string;
      try { contents = await readText(path, fs); }
      catch (error) { throw new Error(`Failed to read ${path}: ${(error as Error).message}`, { cause: error }); }
      if (hunk.kind === "update") update(contents, hunk.chunks, path);
    }
  }
  return applyPatch(patch, cwd, checkPath, fs);
}

/** Apply sequentially, like the upstream standalone engine. Failures do not roll back earlier files. */
export async function applyPatch(patch: string, cwd: string, checkPath?: (path: string) => Promise<void>, fs: PatchFileSystem = hostFileSystem): Promise<PatchResult> {
  const hunks = parsePatch(patch);
  if (!hunks.length) throw new Error("No files were modified.");
  const result: PatchResult = { text: "", added: [], modified: [], deleted: [] };
  for (const hunk of hunks) {
    const path = fs.resolve(cwd, hunk.path);
    await checkPath?.(path);
    if (hunk.kind === "add") {
      await fs.write(path, hunk.contents, true);
      result.added.push(hunk.path);
    } else if (hunk.kind === "delete") {
      try { await fs.remove(path); }
      catch (error) { throw new Error(`Failed to delete file ${path}: ${(error as Error).message}`, { cause: error }); }
      result.deleted.push(hunk.path);
    } else {
      let contents: string;
      try {
        contents = await readText(path, fs);
      } catch (error) {
        throw new Error(`Failed to read file to update ${path}: ${(error as Error).message}`, { cause: error });
      }
      const updated = update(contents, hunk.chunks, path);
      if (hunk.move !== undefined) {
        await checkPath?.(fs.resolve(cwd, hunk.move));
        await fs.write(fs.resolve(cwd, hunk.move), updated, true);
        await checkPath?.(path);
        await fs.remove(path);
        result.modified.push(hunk.move);
      } else {
        await checkPath?.(path);
        await fs.write(path, updated, false);
        result.modified.push(hunk.path);
      }
    }
  }
  result.text = "Success. Updated the following files:\n" + [
    ...result.added.map(path => `A ${path}\n`),
    ...result.modified.map(path => `M ${path}\n`),
    ...result.deleted.map(path => `D ${path}\n`),
  ].join("");
  return result;
}

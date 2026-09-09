// Adapted from OpenAI Codex rust-v0.153.4 (Apache-2.0). See NOTICE.
import type { PatchFileSystem } from "./filesystem.js";
import { parsePatch, trim, trimEnd, type Chunk } from "./parser.js";

const normalize = (s: string): string => trim(s)
  .replace(/[\u2010-\u2015\u2212]/gu, "-")
  .replace(/[\u2018-\u201b]/gu, "'")
  .replace(/[\u201c-\u201f]/gu, '"')
  .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu, " ");

function seek(lines: string[], pattern: string[], start: number, eof: boolean, path: string): number | undefined {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return undefined;
  const from = eof ? lines.length - pattern.length : start;
  const tiers = [
    { name: "exact", transform: (s: string) => s },
    { name: "trailing whitespace", transform: trimEnd },
    { name: "surrounding whitespace", transform: trim },
    { name: "Unicode punctuation", transform: normalize },
  ];
  for (const { name, transform } of tiers) {
    const expected = pattern.map(transform);
    let found: number | undefined;
    let count = 0;
    for (let i = from; i <= lines.length - pattern.length; i++) {
      if (expected.every((line, j) => transform(lines[i + j]) === line)) {
        found = i;
        count++;
      }
    }
    if (count > 1) throw new Error(`Ambiguous match in ${path}: ${count} matches at ${name} tolerance. Add more context or use a unique @@ anchor or *** End of File.`);
    if (count === 1) return found;
  }
  return undefined;
}

function update(contents: string, chunks: Chunk[], path: string): string {
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  // Keep source terminators separate from added lines. Matching still
  // uses the same logical lines and tolerance tiers as before.
  type Line = { text: string; ending: string; added: boolean };
  const source: Line[] = lines.map((text, i) => {
    const terminated = i < lines.length - 1 || contents.endsWith("\n");
    return terminated && text.endsWith("\r")
      ? { text: text.slice(0, -1), ending: "\r\n", added: false }
      : { text, ending: terminated ? "\n" : "", added: false };
  });
  const added = (text: string): Line => ({ text, ending: "", added: true });
  const replacements: { start: number; count: number; lines: Line[] }[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const found = seek(lines, [chunk.context], cursor, false, path);
      if (found === undefined) throw new Error(`Failed to find context '${chunk.context}' in ${path}`);
      cursor = found + 1;
    }
    if (!chunk.old.length) {
      const start = chunk.context !== undefined ? cursor
        : lines.at(-1) === "" ? lines.length - 1 : lines.length;
      replacements.push({ start, count: 0, lines: chunk.replacement.map(added) });
      continue;
    }
    let pattern = chunk.old;
    let newLines = chunk.replacement;
    let found = seek(lines, pattern, cursor, chunk.eof, path);
    if (found === undefined && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = seek(lines, pattern, cursor, chunk.eof, path);
    }
    if (found === undefined) throw new Error(`Failed to find expected lines in ${path}:\n${chunk.old.join("\n")}`);
    replacements.push({ start: found, count: pattern.length,
      lines: newLines.flatMap((text, i) => {
        const index = chunk.sources[i];
        return index === null ? [added(text)] : index < pattern.length ? [source[found + index]] : [];
      }) });
    cursor = found + pattern.length;
  }
  replacements.sort((a, b) => a.start - b.start);
  // Avoid spreading arbitrarily large patches into function arguments.
  let result = source;
  for (const replacement of replacements.reverse()) {
    result = result.slice(0, replacement.start).concat(replacement.lines, result.slice(replacement.start + replacement.count));
  }
  const finalEnding = source.at(-1)?.ending ?? "";
  if (!finalEnding) {
    // Do not manufacture trailing blank lines for an unterminated source.
    while (result.at(-1)?.added && result.at(-1)!.text === "") result.pop();
  }
  // Infer endings in final output order, not chunk order. An unterminated
  // source line moved away from EOF needs the preceding line's separator too.
  let previousEnding = source[0]?.ending || "\n";
  return result.map((line, i) => {
    const ending = i === result.length - 1 ? finalEnding
      : line.added || !line.ending ? previousEnding : line.ending;
    if (ending) previousEnding = ending;
    return line.text + ending;
  }).join("");
}

export type PatchResult = { text: string; added: string[]; modified: string[]; deleted: string[] };

async function readText(path: string, fs: PatchFileSystem): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await fs.read(path));
}

/** Native-tool correctness checks, without Codex's approval/executor machinery. */
export async function applyVerifiedPatch(patch: string, cwd: string, fs: PatchFileSystem): Promise<PatchResult> {
  const seen = new Set<string>();
  for (const hunk of parsePatch(patch)) {
    const path = fs.resolve(cwd, hunk.path);
    await fs.checkPath(path);
    if (hunk.kind === "update" && hunk.move !== undefined) await fs.checkPath(fs.resolve(cwd, hunk.move));
    if (seen.has(path)) throw new Error(`Invalid patch: multiple operations target ${path}`);
    seen.add(path);
    if (hunk.kind === "update") {
      let contents: string;
      try { contents = await readText(path, fs); }
      catch (error) { throw new Error(`Failed to read ${path}: ${(error as Error).message}`, { cause: error }); }
      update(contents, hunk.chunks, path);
    }
  }
  return applyPatch(patch, cwd, fs);
}

/** Apply sequentially, like the upstream standalone engine. Failures do not roll back earlier files. */
export async function applyPatch(patch: string, cwd: string, fs: PatchFileSystem): Promise<PatchResult> {
  const hunks = parsePatch(patch);
  if (!hunks.length) throw new Error("No files were modified.");
  const result: PatchResult = { text: "", added: [], modified: [], deleted: [] };
  for (const hunk of hunks) {
    const path = fs.resolve(cwd, hunk.path);
    await fs.checkPath(path);
    if (hunk.kind === "add") {
      await fs.write(path, hunk.contents, true);
      result.added.push(hunk.path);
    } else if (hunk.kind === "delete") {
      try { await fs.remove(path); }
      catch (error) { throw new Error(`Failed to delete path ${path}: ${(error as Error).message}`, { cause: error }); }
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
        await fs.checkPath(fs.resolve(cwd, hunk.move));
        await fs.write(fs.resolve(cwd, hunk.move), updated, true);
        await fs.checkPath(path);
        await fs.remove(path);
        result.modified.push(hunk.move);
      } else {
        await fs.checkPath(path);
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

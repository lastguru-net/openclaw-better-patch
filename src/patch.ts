// Better Patch implementation redesign. Project provenance and license: see NOTICE.
import { parsePatch, type EditBlock, type FileEdit } from "./parser.js";
import type { PatchFileSystem } from "./filesystem.js";

/** A source line is an offset range, not a normalized copy of its contents. */
class Source {
  readonly offsets: number[] = [0];
  constructor(readonly text: string) {
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
      this.offsets.push(at + 1);
    }
    if (text && !text.endsWith("\n")) this.offsets.push(text.length);
  }
  get size(): number { return this.offsets.length - 1; }
  raw(index: number): string { return this.text.slice(this.offsets[index], this.offsets[index + 1]); }
  ending(index: number): string {
    const end = this.offsets[index + 1];
    return this.text[end - 1] !== "\n" ? "" : this.text[end - 2] === "\r" ? "\r\n" : "\n";
  }
  matchText(index: number): string {
    const raw = this.raw(index);
    return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  }
}

const whitespaceRight = /\p{White_Space}+$/u;
const whitespaceLeft = /^\p{White_Space}+/u;
const punctuation = /[\u2010-\u2015\u2212\u2018-\u201f\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu;
function forms(value: string): string[] {
  const right = value.replace(whitespaceRight, "");
  const surrounding = right.replace(whitespaceLeft, "");
  const folded = surrounding.replace(punctuation, character => {
    const code = character.charCodeAt(0);
    if (code >= 0x2018 && code <= 0x201b) return "'";
    if (code >= 0x201c && code <= 0x201f) return '"';
    if (code >= 0x2010 && code <= 0x2015 || code === 0x2212) return "-";
    return " ";
  });
  return [value, right, surrounding, folded];
}

/** Rank each candidate once; only candidates tied for the best rank compete. */
function locate(source: Source, expected: string[], cursor: number, atEnd: boolean, path: string): number | undefined {
  if (expected.length === 0) return cursor;
  const last = source.size - expected.length;
  if (last < 0) return undefined;
  const needles = expected.map(forms);
  let best = 4;
  let winner: number | undefined;
  let count = 0;
  for (let position = atEnd ? last : cursor; position <= last; position++) {
    let rank = 0;
    for (let offset = 0; offset < needles.length; offset++) {
      const actual = forms(source.matchText(position + offset));
      while (rank < 4 && actual[rank] !== needles[offset][rank]) rank++;
      if (rank > best || rank === 4) break;
    }
    if (rank < best) { best = rank; winner = position; count = 1; }
    else if (rank === best && rank < 4) count++;
  }
  if (count > 1) {
    const tier = ["exact", "trailing whitespace", "surrounding whitespace", "Unicode punctuation"][best];
    throw new Error(`Ambiguous match in ${path}: ${count} matches at ${tier} tolerance. Supply a unique anchor, more context, or an EOF marker.`);
  }
  return winner;
}

// Numbers reference source lines; strings are newly supplied text. A piece table
// keeps untouched ranges compact while edits change the logical line sequence.
type Token = number | string;
type Piece = { first: number; count: number; inserted?: Token[] };
type Change = { position: number; consumed: number; output: Token[] };

function portion(pieces: Piece[], from: number, to = Infinity): Piece[] {
  const selection: Piece[] = [];
  let position = 0;
  for (const piece of pieces) {
    const skip = Math.max(0, from - position);
    const count = Math.min(piece.count, to - position) - skip;
    if (count > 0) selection.push({ ...piece, first: piece.first + skip, count });
    position += piece.count;
    if (position >= to) break;
  }
  return selection;
}

function compile(source: Source, blocks: EditBlock[], path: string): Change[] {
  const changes: Change[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.anchor !== undefined) {
      const anchor = locate(source, [block.anchor], cursor, false, path);
      if (anchor === undefined) throw new Error(`Failed to find context '${block.anchor}' in ${path}`);
      cursor = anchor + 1;
    }
    const expected = block.lines.filter(line => line.kind !== "insert").map(line => line.text);
    let consumed = expected.length;
    let position: number | undefined;
    let shortened = false;
    if (consumed === 0) {
      const append = source.size && source.matchText(source.size - 1) === "" ? source.size - 1 : source.size;
      position = block.anchor === undefined ? append : cursor;
    } else {
      position = locate(source, expected, cursor, block.atEnd, path);
      if (position === undefined && expected[consumed - 1] === "") {
        consumed--;
        shortened = true;
        position = locate(source, expected.slice(0, consumed), cursor, block.atEnd, path);
      }
      if (position === undefined) throw new Error(`Failed to find expected lines in ${path}`);
      cursor = position + consumed;
    }
    const output: Token[] = [];
    let input = 0;
    // A missing final empty context line has no source bytes to retain. The
    // format also tolerates an empty last replacement line in this case.
    let lastOutput = block.lines.length - 1;
    while (lastOutput >= 0 && block.lines[lastOutput].kind === "remove") lastOutput--;
    for (const [index, line] of block.lines.entries()) {
      const omit = shortened && index === lastOutput && line.text === "";
      if (line.kind === "insert") {
        if (!omit) output.push(line.text);
      } else {
        if (line.kind === "keep" && input < consumed && !omit) output.push(position + input);
        input++;
      }
    }
    changes.push({ position, consumed, output });
  }
  return changes;
}

function render(source: Source, changes: Change[]): string {
  let pieces: Piece[] = [{ first: 0, count: source.size }];
  for (const change of changes.sort((a, b) => a.position - b.position).reverse()) {
    pieces = portion(pieces, 0, change.position).concat(
      { first: 0, count: change.output.length, inserted: change.output },
      portion(pieces, change.position + change.consumed),
    );
  }
  const finalEnding = source.size ? source.ending(source.size - 1) : "";
  // Discard generated empty tail lines only for an unterminated original.
  if (!finalEnding) {
    while (pieces.length) {
      const tail = pieces.at(-1)!;
      while (tail.count && tail.inserted?.[tail.first + tail.count - 1] === "") tail.count--;
      if (tail.count) break;
      pieces.pop();
    }
  }
  const size = pieces.reduce((total, piece) => total + piece.count, 0);
  let emitted = 0;
  let inherited = source.size ? source.ending(0) || "\n" : "\n";
  const output: string[] = [];
  for (const piece of pieces) {
    for (let index = piece.first; index < piece.first + piece.count; index++) {
      const token = piece.inserted ? piece.inserted[index] : index;
      const ending = typeof token === "number" ? source.ending(token) : "";
      const raw = typeof token === "number" ? source.raw(token) : token;
      const text = raw.slice(0, raw.length - ending.length);
      const chosen = ++emitted === size ? finalEnding : ending || inherited;
      if (chosen) inherited = chosen;
      output.push(text + chosen);
    }
  }
  return output.join("");
}

export type PatchResult = { text: string; added: string[]; modified: string[]; deleted: string[] };
type Target = { edit: FileEdit; source: string };

async function revised(target: Target, fs: PatchFileSystem): Promise<string> {
  let original: string;
  try { original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await fs.read(target.source)); }
  catch (cause) { throw new Error(`Failed to read file to update ${target.source}: ${(cause as Error).message}`, { cause }); }
  if (target.edit.kind !== "update") throw new Error("Expected an update operation");
  const document = new Source(original);
  return render(document, compile(document, target.edit.blocks, target.source));
}

async function execute(input: string, cwd: string, fs: PatchFileSystem, preflight: boolean): Promise<PatchResult> {
  const edits = parsePatch(input);
  const targetOf = (edit: FileEdit): Target => ({ edit, source: fs.resolve(cwd, edit.path) });
  if (!edits.length) throw new Error("No files were modified.");
  if (preflight) {
    const sources = new Set<string>();
    for (const edit of edits) {
      const target = targetOf(edit);
      await fs.checkPath(target.source);
      if (edit.kind === "update" && edit.destination !== undefined) await fs.checkPath(fs.resolve(cwd, edit.destination));
      if (sources.has(target.source)) throw new Error(`Invalid patch: multiple operations target ${target.source}`);
      sources.add(target.source);
      if (target.edit.kind === "update") await revised(target, fs);
    }
  }
  const result: PatchResult = { text: "", added: [], modified: [], deleted: [] };
  for (const edit of edits) {
    const target = targetOf(edit);
    await fs.checkPath(target.source);
    switch (edit.kind) {
      case "delete":
        try { await fs.remove(target.source); }
        catch (cause) { throw new Error(`Failed to delete path ${target.source}: ${(cause as Error).message}`, { cause }); }
        result.deleted.push(edit.path);
        break;
      case "add":
        await fs.write(target.source, edit.contents, true);
        result.added.push(edit.path);
        break;
      case "update": {
        // Read again after preflight: earlier operations and other writers may
        // have changed the source. Adapter guards remain authoritative at I/O.
        const content = await revised(target, fs);
        const destination = edit.destination === undefined ? target.source : fs.resolve(cwd, edit.destination);
        await fs.checkPath(destination);
        await fs.write(destination, content, edit.destination !== undefined);
        if (edit.destination !== undefined) {
          await fs.checkPath(target.source);
          await fs.remove(target.source);
        }
        result.modified.push(edit.destination ?? edit.path);
        break;
      }
    }
  }
  const rows = [["A", result.added], ["M", result.modified], ["D", result.deleted]] as const;
  result.text = "Success. Updated the following files:\n";
  for (const [label, paths] of rows) for (const path of paths) result.text += `${label} ${path}\n`;
  return result;
}

export const applyVerifiedPatch = (input: string, cwd: string, fs: PatchFileSystem): Promise<PatchResult> => execute(input, cwd, fs, true);
export const applyPatch = (input: string, cwd: string, fs: PatchFileSystem): Promise<PatchResult> => execute(input, cwd, fs, false);

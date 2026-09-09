// Better Patch implementation redesign. Project provenance and license: see NOTICE.
import { parsePatch, type EditBlock, type FileEdit } from "./parser.js";
import type { PatchFileSystem } from "./filesystem.js";
import { preflightFileSystem } from "./preflight.js";

/** A source line is an offset range, not a normalized copy of its contents. */
class Source {
  readonly offsets: number[] = [0];
  readonly text: string;
  readonly bom: string;
  constructor(original: string) {
    this.bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
    this.text = original.slice(this.bom.length);
    for (const match of this.text.matchAll(/\r\n|\n\r|\r|\n/g)) {
      this.offsets.push(match.index! + match[0].length);
    }
    if (this.offsets.at(-1) !== this.text.length) this.offsets.push(this.text.length);
  }
  get size(): number { return this.offsets.length - 1; }
  raw(index: number): string { return this.text.slice(this.offsets[index], this.offsets[index + 1]); }
  ending(index: number): string {
    const end = this.offsets[index + 1];
    const last = this.text[end - 1];
    if (last !== "\r" && last !== "\n") return "";
    const previous = this.text[end - 2];
    return end - this.offsets[index] >= 2 && (previous === "\r" || previous === "\n") && previous !== last
      ? previous + last : last;
  }
  matchText(index: number): string {
    const raw = this.raw(index);
    return raw.slice(0, raw.length - this.ending(index).length);
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
  if (last < cursor) return undefined;
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
    if (consumed === 0) {
      const append = source.size && source.raw(source.size - 1) === source.ending(source.size - 1) ? source.size - 1 : source.size;
      position = block.anchor === undefined ? append : cursor;
    } else {
      position = locate(source, expected, cursor, block.atEnd, path);
      if (position === undefined && expected[consumed - 1] === "") {
        consumed--;
        position = locate(source, expected.slice(0, consumed), cursor, block.atEnd, path);
      }
      if (position === undefined) throw new Error(`Failed to find expected lines in ${path}`);
      cursor = position + consumed;
    }
    const output: Token[] = [];
    let input = 0;
    // Missing final empty context has no source bytes. Explicit insertions,
    // including empty lines, always remain part of the requested output.
    for (const line of block.lines) {
      if (line.kind === "insert") {
        output.push(line.text);
      } else {
        if (line.kind === "keep" && input < consumed) output.push(position + input);
        input++;
      }
    }
    changes.push({ position, consumed, output });
  }
  let consumedUntil = 0;
  for (const change of [...changes].sort((a, b) => a.position - b.position)) {
    if (change.position < consumedUntil) throw new Error(`Overlapping chunks in ${path}`);
    consumedUntil = change.position + change.consumed;
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
      const explicitEmpty = typeof token === "string" && token === "";
      const chosen = ++emitted === size ? finalEnding || (explicitEmpty ? inherited : "") : ending || inherited;
      if (chosen) inherited = chosen;
      output.push(text + chosen);
    }
  }
  return source.bom + output.join("");
}

export type PatchResult = { text: string; added: string[]; modified: string[]; deleted: string[]; unchanged: string[] };
type Target = { edit: FileEdit; source: string };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, i) => value === b[i]);

async function revised(target: Target, fs: PatchFileSystem): Promise<{ original: Uint8Array; content: string }> {
  let original: Uint8Array;
  let text: string;
  try {
    original = await fs.read(target.source);
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original);
  } catch (cause) { throw new Error(`Failed to read file to update ${target.source}: ${(cause as Error).message}`, { cause }); }
  if (target.edit.kind !== "update") throw new Error("Expected an update operation");
  const document = new Source(text);
  return { original, content: render(document, compile(document, target.edit.blocks, target.source)) };
}

async function perform(edit: FileEdit, cwd: string, fs: PatchFileSystem): Promise<boolean> {
  const source = fs.resolve(cwd, edit.path);
  await fs.checkPath(source);
  if (edit.kind === "delete") {
    if (!await fs.inspect(source)) return false;
    try { await fs.remove(source); }
    catch (cause) { throw new Error(`Failed to delete path ${source}: ${(cause as Error).message}`, { cause }); }
  } else if (edit.kind === "add") {
    const info = await fs.inspect(source);
    if (info?.kind === "file" && equal(await fs.read(source), bytes(edit.contents))) return false;
    await fs.write(source, edit.contents, true);
  } else {
    const { original, content } = await revised({ edit, source }, fs);
    const destination = edit.destination === undefined ? source : fs.resolve(cwd, edit.destination);
    await fs.checkPath(destination);
    if (destination === source && equal(original, bytes(content))) return false;
    await fs.write(destination, content, destination !== source);
    if (destination !== source) {
      await fs.checkPath(source);
      await fs.remove(source);
    }
  }
  return true;
}

async function execute(input: string, cwd: string, fs: PatchFileSystem, preflight: boolean): Promise<PatchResult> {
  const edits = parsePatch(input);
  if (!edits.length) throw new Error("No files were modified.");
  if (preflight) {
    const virtual = preflightFileSystem(fs);
    for (const edit of edits) await perform(edit, cwd, virtual);
  }
  // Capture only explicitly named paths. Pure deletes never read file contents.
  const paths = new Map<string, { label: string; written: boolean }>();
  for (const edit of edits) {
    const source = fs.resolve(cwd, edit.path);
    const previous = paths.get(source);
    paths.set(source, { label: previous?.label ?? edit.path, written: previous?.written || edit.kind !== "delete" });
    if (edit.kind === "update" && edit.destination !== undefined) {
      const destination = fs.resolve(cwd, edit.destination);
      paths.set(destination, { label: paths.get(destination)?.label ?? edit.destination, written: true });
    }
  }
  const initial = new Map<string, { kind: string; data?: Uint8Array } | null>();
  for (const [path, spec] of paths) {
    await fs.checkPath(path);
    const info = await fs.inspect(path);
    initial.set(path, info ? { ...info, ...(spec.written && info.kind === "file" ? { data: await fs.read(path) } : {}) } : null);
  }
  // Re-evaluate against current bytes, not the discarded preflight snapshot.
  const mutated = new Set<string>();
  for (const edit of edits) {
    if (await perform(edit, cwd, fs)) {
      mutated.add(fs.resolve(cwd, edit.path));
      if (edit.kind === "update" && edit.destination !== undefined) mutated.add(fs.resolve(cwd, edit.destination));
    }
  }
  const result: PatchResult = { text: "", added: [], modified: [], deleted: [], unchanged: [] };
  for (const [path, spec] of paths) {
    const before = initial.get(path)!;
    const after = await fs.inspect(path);
    if (!before && after) result.added.push(spec.label);
    else if (before && !after) result.deleted.push(spec.label);
    else if (!mutated.has(path) && before?.kind === after?.kind || !before && !after || before?.kind === "directory" && after?.kind === "directory"
      || before?.data && after?.kind === "file" && equal(before.data, await fs.read(path))) result.unchanged.push(spec.label);
    else result.modified.push(spec.label);
  }
  result.text = result.added.length || result.modified.length || result.deleted.length
    ? "Success. Updated the following files:\n" : "No changes made.\n";
  const rows = [["A", result.added], ["M", result.modified], ["D", result.deleted], ["N", result.unchanged]] as const;
  for (const [label, paths] of rows) for (const path of paths) result.text += `${label} ${path}\n`;
  return result;
}

export const applyVerifiedPatch = (input: string, cwd: string, fs: PatchFileSystem): Promise<PatchResult> => execute(input, cwd, fs, true);
export const applyPatch = (input: string, cwd: string, fs: PatchFileSystem): Promise<PatchResult> => execute(input, cwd, fs, false);
